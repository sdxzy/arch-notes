// 模拟周一 10 点高峰：300 个 PR / 10 分钟，每个 PR 8 路并发 LLM 调用；客服 Bot 共用同一个 key。
// 运行：npx tsx sim.ts      （虚拟时钟，1 秒内跑完）
import { Pool, Scheduler, RetryBudget, backoffMs, Lane, Ticket } from "./limiter";

const VENDOR_RPM = 500, VENDOR_TPM = 2_000_000, MAX_OUT = 1500;
const TICK = 100; // 虚拟时钟步长 ms

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** 模拟供应商：60 秒滑动窗口，按"输入 + 实际输出"记账；超限返回 429 + Retry-After */
class MockVendor {
  log: { t: number; tok: number }[] = []; count429 = 0;
  call(now: number, tokens: number): { ok: true } | { ok: false; retryAfterMs: number } {
    this.log = this.log.filter(e => e.t > now - 60_000);
    const used = this.log.reduce((s, e) => s + e.tok, 0);
    if (this.log.length + 1 > VENDOR_RPM || used + tokens > VENDOR_TPM) {
      this.count429++;
      return { ok: false, retryAfterMs: Math.max(1000, this.log[0].t + 60_000 - now) };
    }
    this.log.push({ t: now, tok: tokens }); return { ok: true };
  }
}

interface Call { id: number; lane: Lane; pr?: number; input: number; output: number; created: number; attempt: number; firstStart?: number; }

function workload(trimRatio: number) {
  const r = rng(42); const calls: Call[] = []; let id = 0;
  // 客服：全程 40 分钟，每分钟 120 次，每次约 4k 入 + 1k 出 ≈ 占 30% TPM
  for (let t = 0; t < 40 * 60_000; t += 500) calls.push({ id: id++, lane: "cs", input: 3000 + r() * 2000, output: 1000, created: t, attempt: 0 });
  // PR：300 个，前 3 分钟最密（突发），20% 是草稿；输入长尾，偶尔 30k 的大 PR
  for (let p = 0; p < 300; p++) {
    const t = p < 150 ? r() * 180_000 : 180_000 + r() * 420_000;
    const lane: Lane = r() < 0.2 ? "draft" : "review";
    const big = r() < 0.04;
    for (let k = 0; k < 8; k++) {
      const input = (big ? 30_000 : 4000 + r() * 3000) * (1 - trimRatio);
      calls.push({ id: id++, lane, pr: p, input, output: 400 + r() * 800, created: t, attempt: 0 });
    }
  }
  return calls.sort((a, b) => a.created - b.created);
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const min = (ms: number) => (ms / 60_000).toFixed(1) + "min";

function run(mode: "naive" | "limiter", trimRatio = 0) {
  const r = rng(7); const vendor = new MockVendor(); const budget = new RetryBudget();
  const calls = workload(trimRatio); let next = 0;
  const sched = new Scheduler(new Pool("cs-reserved", VENDOR_RPM * 0.3, VENDOR_TPM * 0.3), new Pool("shared", VENDOR_RPM * 0.7, VENDOR_TPM * 0.7));
  const waiting: Ticket[] = []; const byId = new Map(calls.map(c => [c.id, c]));
  const inflight: { end: number; c: Call; t: Ticket }[] = [];
  const NAIVE_POOL = 64; let naiveInflightReview = 0;
  const waits: Record<Lane, number[]> = { cs: [], review: [], draft: [] };
  const prDone = new Map<number, { left: number; created: number; end: number }>();
  const csFailed = { n: 0 }; let failed = 0; let cs429 = 0;
  const tokPerMin = new Map<number, number>();
  let now = 0;
  const finish = (c: Call) => {
    if (c.pr !== undefined) { const d = prDone.get(c.pr) ?? { left: 8, created: c.created, end: 0 }; d.left--; d.end = now; prDone.set(c.pr, d); }
  };
  for (; now < 120 * 60_000; now += TICK) {
    while (next < calls.length && calls[next].created <= now) {
      const c = calls[next++]; budget.onRequest();
      waiting.push({ id: c.id, lane: c.lane, estTokens: Math.ceil(c.input * (1 + (r() - 0.5) * 0.1)) + MAX_OUT, enqueuedAt: now, notBefore: now });
    }
    // 完成的请求：对账
    for (let i = inflight.length - 1; i >= 0; i--) if (inflight[i].end <= now) {
      const { c, t } = inflight[i]; inflight.splice(i, 1);
      t.pool?.reconcile(t.estTokens, c.input + c.output);
      if (c.lane !== "cs") naiveInflightReview--;
      finish(c);
    }
    // 选出本轮要发的请求
    let toSend: Ticket[];
    if (mode === "limiter") { waiting.forEach(t => sched.enqueue(t)); waiting.length = 0; toSend = sched.dispatch(now); }
    else {
      toSend = waiting.filter(t => t.notBefore <= now && (t.lane === "cs" || naiveInflightReview < NAIVE_POOL) && (t.lane === "cs" || ++naiveInflightReview));
      const s = new Set(toSend); for (let i = waiting.length - 1; i >= 0; i--) if (s.has(waiting[i])) waiting.splice(i, 1);
    }
    for (const t of toSend) {
      const c = byId.get(t.id)!;
      if (c.firstStart === undefined) { c.firstStart = now; waits[c.lane].push(now - t.enqueuedAt); }
      const res = vendor.call(now, c.input + c.output);
      if (res.ok) {
        inflight.push({ end: now + 3000 + r() * 9000, c, t });
        const m = Math.floor(now / 60_000); tokPerMin.set(m, (tokPerMin.get(m) ?? 0) + c.input + c.output);
        continue;
      }
      if (c.lane === "cs") cs429++;
      t.pool?.reconcile(t.estTokens, 0); // 没被处理，额度退回
      if (mode === "naive" && c.lane !== "cs") naiveInflightReview--;
      c.attempt++;
      const giveUp = mode === "limiter" ? (c.attempt > 4 || !budget.tryRetry()) : c.attempt > (c.lane === "cs" ? 3 : 50);
      if (giveUp) { failed++; if (c.lane === "cs") csFailed.n++; finish(c); continue; }
      // naive：固定 1 秒后立刻重试；limiter：Retry-After + 指数退避 + 抖动
      t.notBefore = now + (mode === "naive" ? 1000 : backoffMs(c.attempt, res.retryAfterMs, r));
      if (mode === "limiter") sched.enqueue(t); else waiting.push(t);
    }
    if (next >= calls.length && !waiting.length && !sched.queue.length && !inflight.length) break;
  }
  const prLat = [...prDone.values()].map(d => d.end - d.created);
  const draftLat = [...prDone.entries()].filter(([p]) => calls.find(c => c.pr === p)!.lane === "draft").map(([, d]) => d.end - d.created);
  const reviewLat = [...prDone.entries()].filter(([p]) => calls.find(c => c.pr === p)!.lane === "review").map(([, d]) => d.end - d.created);
  const peakTpm = Math.max(...tokPerMin.values());
  const label = mode === "naive" ? "A. 朴素：并发池 64 + 429 后 1 秒立即重试" : trimRatio ? `C. 限流器 + 上下文裁剪 ${trimRatio * 100}%` : "B. 双桶限流器 + 优先级 + 退避/重试预算";
  console.log(`\n=== ${label} ===`);
  console.log(`  供应商 429 次数        : ${vendor.count429}（其中客服 ${cs429}）`);
  console.log(`  最终失败调用           : ${failed}（客服失败 ${csFailed.n}）${mode === "limiter" ? `，重试预算拒绝 ${budget.denied}` : ""}`);
  console.log(`  峰值分钟吞吐           : ${(peakTpm / 1e6).toFixed(2)}M tokens/min（供应商上限 2.00M）`);
  console.log(`  排队等待 p50/p95  客服 : ${(pct(waits.cs, 50) / 1000).toFixed(1)}s / ${(pct(waits.cs, 95) / 1000).toFixed(1)}s`);
  console.log(`                    评审 : ${min(pct(waits.review, 50))} / ${min(pct(waits.review, 95))}`);
  console.log(`                    草稿 : ${min(pct(waits.draft, 50))} / ${min(pct(waits.draft, 95))}`);
  console.log(`  PR 完成耗时 p50/p95    : 评审 ${min(pct(reviewLat, 50))} / ${min(pct(reviewLat, 95))}，草稿 ${min(pct(draftLat, 50))} / ${min(pct(draftLat, 95))}`);
  console.log(`  全部 PR 评完           : 第 ${min(Math.max(...[...prDone.values()].map(d => d.end)))}`);
  return { csFailed: csFailed.n, csP95: pct(waits.cs, 95) };
}

run("naive");
const b = run("limiter");
run("limiter", 0.4);
console.log(`\n客服 Bot 未被饿死：${b.csFailed === 0 && b.csP95 < 5000 ? "✅" : "❌"}（限流模式下客服失败 ${b.csFailed} 次，p95 等待 ${(b.csP95 / 1000).toFixed(1)}s）`);
