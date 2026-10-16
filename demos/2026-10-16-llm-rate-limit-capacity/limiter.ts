// 双桶限流器：RPM + TPM 两个令牌桶，预估扣减 + 事后对账，按优先级分道。
// 纯内存、虚拟时钟版本，便于理解原理；生产中把桶放进 Redis（Lua 原子扣减）供多实例共享。

export type Lane = "cs" | "review" | "draft"; // 客服(高/保底) / 评审(普通) / 草稿(低)
export const LANE_PRIORITY: Record<Lane, number> = { cs: 0, review: 1, draft: 2 };

export class TokenBucket {
  tokens: number;
  constructor(public capacity: number, public refillPerMs: number, private last = 0) {
    this.tokens = capacity;
  }
  refill(now: number) {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }
  canTake(n: number) { return this.tokens >= n; }
  take(n: number) { this.tokens -= n; }
  give(n: number) { this.tokens = Math.min(this.capacity, this.tokens + n); }
}

/** 一个"额度池" = RPM 桶 + TPM 桶，两个都够才放行 */
export class Pool {
  rpm: TokenBucket; tpm: TokenBucket;
  /**
   * @param rpm 每分钟请求数
   * @param tpm 每分钟 token 数
   * @param safety 只用到额度的多少（留余量给估算误差）
   * @param burstSec 桶容量 = 多少秒的额度（越小越平滑，越不容易撞供应商的滑动窗口）
   */
  constructor(public name: string, rpm: number, tpm: number, safety = 0.9, burstSec = 5) {
    this.rpm = new TokenBucket((rpm * burstSec) / 60, (rpm * safety) / 60000);
    this.tpm = new TokenBucket((tpm * burstSec) / 60, (tpm * safety) / 60000);
  }
  refill(now: number) { this.rpm.refill(now); this.tpm.refill(now); }
  tryAcquire(estTokens: number) {
    if (!this.rpm.canTake(1) || !this.tpm.canTake(estTokens)) return false;
    this.rpm.take(1); this.tpm.take(estTokens); return true;
  }
  /** 对账：预留的是 input + max_output，实际用得少就退回差额（用多了就补扣） */
  reconcile(reserved: number, actual: number) {
    const diff = reserved - actual;
    if (diff >= 0) this.tpm.give(diff); else this.tpm.take(-diff);
  }
}

export interface Ticket {
  id: number; lane: Lane; estTokens: number; enqueuedAt: number;
  notBefore: number; // 退避期间不参与调度
  pool?: Pool;
}

/**
 * 调度器：客服先用自己的保底池，不够再按最高优先级借共享池；
 * 评审 > 草稿；草稿等待超过 agingMs 后提升为普通优先级，防止饿死。
 */
export class Scheduler {
  queue: Ticket[] = [];
  constructor(public reserved: Pool, public shared: Pool, public agingMs = 5 * 60_000) {}
  enqueue(t: Ticket) { this.queue.push(t); }
  /** 返回本轮放行的请求 */
  dispatch(now: number): Ticket[] {
    this.reserved.refill(now); this.shared.refill(now);
    const prio = (t: Ticket) =>
      t.lane === "draft" && now - t.enqueuedAt > this.agingMs ? 1 : LANE_PRIORITY[t.lane];
    const ready = this.queue.filter(t => t.notBefore <= now)
      .sort((a, b) => prio(a) - prio(b) || a.enqueuedAt - b.enqueuedAt);
    const out: Ticket[] = [];
    let blockedPrio = Infinity; // 高优先级被挡住时，不让低优先级"插队"吃掉刚回来的额度
    for (const t of ready) {
      const p = prio(t);
      if (p > blockedPrio) break;
      if (t.lane === "cs" && this.reserved.tryAcquire(t.estTokens)) t.pool = this.reserved;
      else if (this.shared.tryAcquire(t.estTokens)) t.pool = this.shared;
      else { blockedPrio = p; continue; }
      out.push(t);
    }
    if (out.length) { const s = new Set(out); this.queue = this.queue.filter(t => !s.has(t)); }
    return out;
  }
}

/** 重试预算：全局最多允许"成功请求数 × ratio + floor"次重试，防止重试风暴 */
export class RetryBudget {
  private requests = 0; private retries = 0; denied = 0;
  constructor(private ratio = 0.1, private floor = 20) {}
  onRequest() { this.requests++; }
  tryRetry() {
    if (this.retries < this.requests * this.ratio + this.floor) { this.retries++; return true; }
    this.denied++; return false;
  }
}

/** 退避：尊重 Retry-After，再叠加指数退避 + 全抖动（full jitter） */
export function backoffMs(attempt: number, retryAfterMs: number, rand: () => number, base = 1000, cap = 30_000) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.max(retryAfterMs, rand() * exp);
}
