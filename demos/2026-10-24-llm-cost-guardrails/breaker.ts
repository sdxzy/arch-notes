// 断路器：同一【触发源】（调度 id，不是用户 id）连续失败 N 次就暂停，冷却后半开探测。
// 状态全在 StateStore 里（生产：DB 为准 + Redis 加速），进程重启、多实例都不丢。
//
// 状态：closed（正常）→ open（暂停，paused_until 之前一律拒绝）→ half-open（冷却到了，只放 1 个探测）→ 成功回 closed / 失败回 open

import { CircuitOpenError } from "./errors.js";
import type { Clock, StateStore } from "./store.js";

export interface BreakerOpts {
  threshold: number; // 连续失败 N 次
  cooldownMs: number; // 暂停多久后半开
  onTrip?: (info: { scheduleId: string; failures: number; lastError: string; resumeAt: number; reopened: boolean }) => void; // 通知用户
}

export type FailureKind = "retryable" | "user_cancel";

export class CircuitBreaker {
  constructor(private store: StateStore, private clock: Clock, private o: BreakerOpts) {}
  private k = (id: string, f: string) => `cb:${id}:${f}`;

  async state(id: string): Promise<"closed" | "open" | "half-open"> {
    const until = Number((await this.store.get(this.k(id, "paused_until"))) ?? 0);
    if (!until) return "closed";
    return this.clock.now() < until ? "open" : "half-open";
  }

  /** 每次触发 run 前调用。open 抛 CircuitOpenError；half-open 只放一个探测，其余也拒绝。 */
  async allow(id: string): Promise<{ probe: boolean }> {
    const st = await this.state(id);
    if (st === "closed") return { probe: false };
    const until = Number(await this.store.get(this.k(id, "paused_until")));
    if (st === "open") throw new CircuitOpenError(id, until);
    const won = await this.store.setIfAbsent(this.k(id, "probe"), 1, this.o.cooldownMs); // SET NX：只有一个调用者抢到
    if (!won) throw new CircuitOpenError(id, until);
    return { probe: true };
  }

  async recordSuccess(id: string) {
    await this.store.del(this.k(id, "fails"));
    await this.store.del(this.k(id, "paused_until"));
    await this.store.del(this.k(id, "probe"));
  }

  async recordFailure(id: string, kind: FailureKind, error: string) {
    if (kind === "user_cancel") return; // 用户主动取消不算失败
    await this.store.set(this.k(id, "last_error"), error);
    await this.store.set(this.k(id, "last_failure_at"), this.clock.now());
    const wasHalfOpen = (await this.state(id)) === "half-open";
    const n = await this.store.incr(this.k(id, "fails")); // 原子 +1，不是先读后写
    if (n >= this.o.threshold || wasHalfOpen) {
      const resumeAt = this.clock.now() + this.o.cooldownMs;
      await this.store.set(this.k(id, "paused_until"), resumeAt);
      await this.store.del(this.k(id, "probe"));
      this.o.onTrip?.({ scheduleId: id, failures: n, lastError: error, resumeAt, reopened: wasHalfOpen });
    }
  }
}
