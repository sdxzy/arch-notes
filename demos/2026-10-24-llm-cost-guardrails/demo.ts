// 运行：npx tsx demo.ts（或 bash test.sh）。全程离线，LLM 和工具都是 mock，时钟是假的。
import {
  BudgetManager, CircuitBreaker, CircuitOpenError, FairScheduler, FakeClock, GuardedRun, MemoryStore,
  QuotaExceededError, RateLimitedError, RunLimitError, costOf, worstCase,
  type Action, type LLM, type RunLimits, type StateStore, DEFAULT_LIMITS,
} from "./index.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${extra ? "  → " + extra : ""}`);
};
const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
const title = (s: string) => console.log(`\n━━ ${s}`);
const tick = () => Promise.resolve();

/** mock LLM：每次返回 gen(i) 给的动作和 token 用量；可选推进假时钟。 */
function mockLLM(clock: FakeClock, gen: (i: number) => Action, usage = { inputTokens: 500, outputTokens: 100 }, advanceMs = 0): LLM {
  let i = 0;
  return {
    async chat() {
      await tick();
      clock.advance(advanceMs);
      return { action: gen(i++), usage };
    },
  };
}
const catchErr = async (f: () => Promise<unknown>) => { try { await f(); return undefined; } catch (e) { return e; } };

// ───────────────────────────────────────────────────────────────
title("1. 单 run 护栏：死循环被步数 / 花费 / 重复动作 / 超时拦住");
{
  const clock = new FakeClock();
  const same = (): Action => ({ tool: "fetch_report", args: { id: 42 } });
  const base: RunLimits = { ...DEFAULT_LIMITS };

  // (a) 调工具→报错→让 LLM 重试：Dong 最初的"重试次数上限"能拦住
  {
    const run = new GuardedRun({ userId: "u", limits: base, llm: mockLLM(clock, same), clock });
    const e = await catchErr(async () => { for (;;) { await run.step(500, 1000); try { throw new Error("tool 500"); } catch { run.toolError(); } } });
    check("(a) 报错死循环 → 被『工具连续报错』拦住", e instanceof RunLimitError && e.reason === "max_tool_errors", `${run.steps} 步，花 ${run.costMicro}µ$`);
  }
  // (b) 工具调用都成功，LLM 重复同一动作：重试计数永远是 0
  {
    // b0：只有"重试次数上限"的护栏 → 失控。测试用 2000 步当安全阀，真实世界没有这个阀。
    const only: RunLimits = { ...base, maxSteps: Infinity, maxCostMicro: Infinity, maxTokens: Infinity, maxWallMs: Infinity, repeatThreshold: Infinity };
    const run = new GuardedRun({ userId: "u", limits: only, llm: mockLLM(clock, same), clock });
    let e: unknown;
    for (let i = 0; i < 2000 && !e; i++) { e = await catchErr(async () => { await run.step(500, 1000); run.toolOk(); }); }
    check("(b0) 无报错循环 + 只有重试上限 → 拦不住（跑满 2000 步）", e === undefined && run.steps === 2000, `${run.steps} 步，已花 ${usd(run.costMicro)}`);
    // b1：加上重复动作检测
    const run2 = new GuardedRun({ userId: "u", limits: base, llm: mockLLM(clock, same), clock });
    const e2 = await catchErr(async () => { for (;;) { await run2.step(500, 1000); run2.toolOk(); } });
    check("(b1) 同样的循环 + 重复动作检测 → 第 6 步拦住", e2 instanceof RunLimitError && e2.reason === "repeat_action" && run2.steps === 6, e2 instanceof Error ? e2.message : "");
  }
  // (c) 参数每次略有不同（带时间戳/计数器）：重复检测被绕过，靠步数上限兜底
  {
    const run = new GuardedRun({ userId: "u", limits: base, llm: mockLLM(clock, () => ({ tool: "fetch_report", args: { id: 42, ts: Math.random() } })), clock });
    const e = await catchErr(async () => { for (;;) { await run.step(500, 1000); run.toolOk(); } });
    check("(c) 参数在变 → 重复检测失效，总步数上限兜底", e instanceof RunLimitError && e.reason === "max_steps" && run.steps === 30, `${run.steps} 步`);
  }
  // (d) 每步很贵：花费上限先到，且是"调用前"按最坏情况拒绝，不会超
  {
    const run = new GuardedRun({ userId: "u", limits: base, llm: mockLLM(clock, () => ({ tool: "t", args: Math.random() }), { inputTokens: 20000, outputTokens: 2000 }), clock });
    const e = await catchErr(async () => { for (;;) await run.step(20000, 1000); });
    check("(d) 单步很贵 → 花费上限先到，实际花费不超上限", e instanceof RunLimitError && e.reason === "max_cost" && run.costMicro <= base.maxCostMicro, `${run.steps} 步，${usd(run.costMicro)} / ${usd(base.maxCostMicro)}`);
  }
  // (e) 每步很慢：总时长上限
  {
    const c2 = new FakeClock();
    const run = new GuardedRun({ userId: "u", limits: base, llm: mockLLM(c2, () => ({ tool: "t", args: Math.random() }), undefined, 30_000), clock: c2 });
    const e = await catchErr(async () => { for (;;) await run.step(500, 1000); });
    check("(e) 每步 30s → 总时长上限（120s）拦住", e instanceof RunLimitError && e.reason === "timeout" && run.steps === 5, `${run.steps} 步`);
  }
}

// ───────────────────────────────────────────────────────────────
title("2. 用户日预算（预占 + 结算）：500 个 run 叠加也烧不穿");
{
  const clock = new FakeClock(1_000 * 24 * 3600 * 1000);
  const store = new MemoryStore(clock);
  const USER_LIMIT = 1_000_000; // $1
  const budget = new BudgetManager(store, clock, { userDaily: USER_LIMIT, globalDaily: 1_300_000 });
  // 真实花费 = 每步 2000 in / 300 out = 10_500µ$；预占按最坏 2000 in / 1000 max_tokens = 21_000µ$
  const ACTUAL = costOf(2000, 300), WORST = worstCase(2000, 1000);
  let totalActual = 0;
  const llm: LLM = { async chat() { await tick(); totalActual += ACTUAL; return { action: { tool: "t", args: Math.random() }, usage: { inputTokens: 2000, outputTokens: 300 } }; } };
  const sched = new FairScheduler({ maxConcurrent: 5, maxPerUser: 5, maxQueued: 1000, maxQueuedPerUser: 1000, maxWaitMs: 1e9, avgTaskMs: 1000 }, clock);

  const outcome = { completed: 0, quota: 0, other: 0 };
  let quotaScope = "";
  const oneRun = (user: string) => async () => {
    const run = new GuardedRun({ userId: user, limits: DEFAULT_LIMITS, llm, clock, budget });
    try { for (let i = 0; i < 5; i++) await run.step(2000, 1000); outcome.completed++; }
    catch (e) { if (e instanceof QuotaExceededError) { outcome.quota++; quotaScope = e.scope; } else outcome.other++; }
  };
  await Promise.all(Array.from({ length: 500 }, () => sched.submit("alice", oneRun("alice"))));
  const u = await budget.used("alice");
  check("500 个 run 全部有结果，没有卡死", outcome.completed + outcome.quota + outcome.other === 500, `完成 ${outcome.completed}，额度拒绝 ${outcome.quota}`);
  check("alice 当天花费从未超过日预算", u.user <= USER_LIMIT, `${usd(u.user)} / ${usd(USER_LIMIT)}`);
  check("额度类限制：超额的 run 直接拒绝（402），没有排队等恢复", outcome.quota > 400 && quotaScope === "user_daily");
  check("结算正确：库里的用量 == 真实花费（预占差额都退了）", u.user === totalActual, `${u.user} == ${totalActual}`);

  // 为什么要结算：只预占不退差额，吞吐只有一半
  const s2 = new MemoryStore(clock);
  const b2 = new BudgetManager(s2, clock, { userDaily: USER_LIMIT, globalDaily: 1e12 });
  let withSettle = 0, reserveOnly = 0;
  for (;;) { try { const r = await b2.reserve("x", WORST); await b2.settle(r, ACTUAL); withSettle++; } catch { break; } }
  const b3 = new BudgetManager(new MemoryStore(clock), clock, { userDaily: USER_LIMIT, globalDaily: 1e12 });
  for (;;) { try { await b3.reserve("x", WORST); reserveOnly++; } catch { break; } }
  check("预占+结算 比 只预占 多放行近一倍的调用", withSettle > reserveOnly * 1.8, `${withSettle} 次 vs ${reserveOnly} 次`);

  // 其他用户不受 alice 影响（用户级隔离）；全局预算是最后保险
  const bobOut = { completed: 0, quota: 0 }; let bobScope = "";
  for (let i = 0; i < 20; i++) {
    const run = new GuardedRun({ userId: "bob", limits: DEFAULT_LIMITS, llm, clock, budget });
    try { for (let k = 0; k < 5; k++) await run.step(2000, 1000); bobOut.completed++; } catch (e) { if (e instanceof QuotaExceededError) { bobOut.quota++; bobScope = e.scope; } }
  }
  const bu = await budget.used("bob");
  check("alice 烧光后 bob 仍能跑（用户级隔离）", bobOut.completed >= 1);
  check("bob 被『全局预算』拦住，且拒绝时用户计数已回滚", bobScope === "global_daily" && bu.user <= 300_000 + 21_000, `bob 用量 ${usd(bu.user)}，全局 ${usd(bu.global)}`);
  check("全局预算从未超过", bu.global <= 1_300_000);
  const nextDay = new FakeClock(clock.now() + 24 * 3600 * 1000);
  const b4 = new BudgetManager(new MemoryStore(nextDay), nextDay, { userDaily: USER_LIMIT, globalDaily: 1e9 });
  check("次日 key 换新，额度自然重置", (await b4.used("alice")).user === 0);
}

// ───────────────────────────────────────────────────────────────
title("3. 并发 + 有界公平队列：满了就 429 + Retry-After");
{
  const clock = new FakeClock();
  const s = new FairScheduler({ maxConcurrent: 2, maxPerUser: 2, maxQueued: 3, maxQueuedPerUser: 2, maxWaitMs: 30_000, avgTaskMs: 10_000 }, clock);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (name: string) => () => new Promise<string>((res) => { started.push(name); gates.set(name, () => res(name)); });
  const sub = (user: string, name: string) => { const p = s.submit(user, job(name)); p.catch(() => {}); return p; };

  const a1 = sub("alice", "a1"), a2 = sub("alice", "a2"), a3 = sub("alice", "a3"), a4 = sub("alice", "a4");
  const a5 = sub("alice", "a5");
  const b1 = sub("bob", "b1");
  const c1 = sub("carol", "c1");
  const r5 = await catchErr(() => a5) as RateLimitedError, rc = await catchErr(() => c1) as RateLimitedError;
  check("前 2 个直接跑，后面进队列", started.join() === "a1,a2" && s.queued === 3);
  check("alice 队列份额用完 → a5 被拒（热用户挤不满整个队列）", r5 instanceof RateLimitedError && r5.reason === "user_queue_full");
  check("bob 仍能排队（有自己的份额）", s.queued === 3);
  check("全局队列满 → carol 被拒：429 + Retry-After", rc instanceof RateLimitedError && rc.reason === "queue_full" && rc.toHttp().status === 429 && Number(rc.toHttp().headers["Retry-After"]) >= 1, JSON.stringify(rc.toHttp().headers));

  gates.get("a1")!();
  await a1; await tick(); await tick();
  check("空出名额时公平调度：bob 的 b1 先于 alice 的 a3 开跑", started.join() === "a1,a2,b1", started.join(","));

  clock.advance(31_000);
  const d1 = sub("dave", "d1"); // submit 时顺带清理过期的排队任务
  const e3 = await catchErr(() => a3) as RateLimitedError, e4 = await catchErr(() => a4) as RateLimitedError;
  check("排队超过 30s 的任务被拒绝（等待时间上限）", e3?.reason === "queue_wait_exceeded" && e4?.reason === "queue_wait_exceeded");
  gates.get("a2")!(); await tick(); await tick();
  gates.get("b1")!(); gates.get("d1")!();
  await Promise.all([a2, b1, d1]);
  check("全部结束后队列和并发都归零", s.queued === 0);
}

// ───────────────────────────────────────────────────────────────
title("4. 断路器：同一调度连续失败 N 次暂停；成功清零；冷却后半开");
{
  const clock = new FakeClock(1_000_000);
  const store = new MemoryStore(clock);
  const trips: string[] = [];
  const cb = new CircuitBreaker(store, clock, { threshold: 3, cooldownMs: 60_000, onTrip: (i) => trips.push(`${i.scheduleId}${i.reopened ? "(re)" : ""}`) });
  const S = "weekly-digest";

  await cb.recordFailure(S, "retryable", "tool 500"); await cb.recordFailure(S, "retryable", "tool 500");
  await cb.recordSuccess(S);
  await cb.recordFailure(S, "retryable", "tool 500"); await cb.recordFailure(S, "retryable", "tool 500");
  check("失败 2 次 → 成功清零 → 再失败 2 次：仍然关闭", (await cb.state(S)) === "closed");
  await cb.recordFailure(S, "user_cancel", "用户点了停止");
  check("用户主动取消不计数", (await cb.state(S)) === "closed" && Number(await store.get(`cb:${S}:fails`)) === 2);
  await cb.recordFailure(S, "retryable", "tool 500");
  check("连续第 3 次失败 → 打开并通知用户", (await cb.state(S)) === "open" && trips.join() === S);
  const e = await catchErr(() => cb.allow(S));
  check("打开期间拒绝触发（409 schedule_paused）", e instanceof CircuitOpenError && e.toHttp().status === 409);
  check("别的调度不受牵连（key 是调度 id，不是用户 id）", (await cb.allow("other-schedule")).probe === false);

  clock.advance(61_000);
  check("冷却结束 → 半开", (await cb.state(S)) === "half-open");
  const [p1, p2] = await Promise.all([catchErr(() => cb.allow(S)), catchErr(() => cb.allow(S))]);
  check("半开只放一个探测（SET NX 抢名额）", [p1, p2].filter((x) => x === undefined || (x as any).probe).length === 1 && [p1, p2].filter((x) => x instanceof CircuitOpenError).length === 1);
  await cb.recordFailure(S, "retryable", "tool 500");
  check("探测失败 → 立刻重新打开（不用再数 3 次）", (await cb.state(S)) === "open" && trips.length === 2 && trips[1].endsWith("(re)"));
  clock.advance(61_000);
  await cb.allow(S); await cb.recordSuccess(S);
  check("探测成功 → 关闭，计数清零", (await cb.state(S)) === "closed" && (await store.get(`cb:${S}:fails`)) === undefined);

  // 场景复现：定时任务每分钟触发，每次都失败，整晚 8 小时
  const runCost = 100_000; // 每个失败 run 花 $0.10
  const simulate = async (useBreaker: boolean) => {
    const c = new FakeClock(0), st = new MemoryStore(c);
    const br = new CircuitBreaker(st, c, { threshold: 3, cooldownMs: 3600_000 });
    let runs = 0;
    for (let min = 0; min < 480; min++, c.advance(60_000)) {
      if (useBreaker && (await catchErr(() => br.allow("cron")))) continue;
      runs++;
      await br.recordFailure("cron", "retryable", "tool 500");
    }
    return runs;
  };
  const noCb = await simulate(false), withCb = await simulate(true);
  check("整晚每分钟自动新建 run：无断路器 480 个，有断路器 ≤ 12 个", noCb === 480 && withCb <= 12, `${noCb} 个 (${usd(noCb * runCost)}) vs ${withCb} 个 (${usd(withCb * runCost)})`);
}

// ───────────────────────────────────────────────────────────────
title("5. 状态存取：为什么必须是原子操作（内存 Map 仅为演示，生产用 DB / Redis）");
{
  const clock = new FakeClock();
  const store: StateStore = new MemoryStore(clock);
  // 错误写法：先读后写。100 个并发都读到 0，各自写 1，丢了 99 次。
  const naive = async (k: string) => { const v = Number((await store.get(k)) ?? 0); await tick(); await store.set(k, v + 1); };
  await Promise.all(Array.from({ length: 100 }, () => naive("naive")));
  const lost = Number(await store.get("naive"));
  await Promise.all(Array.from({ length: 100 }, () => store.incr("atomic")));
  const exact = Number(await store.get("atomic"));
  check("先读后写：100 次并发只算到很少（少算 = 断路器永远数不到 N）", lost < 100, `得到 ${lost}`);
  check("原子 incr（对应 UPDATE n = n + 1 RETURNING / INCR）：精确 100", exact === 100);
  const rs = await Promise.all(Array.from({ length: 200 }, () => store.incrIfBelow("quota", 10, 1000)));
  check("原子『没超额才加』：200 个并发预占，恰好放行 100 个，总量不超限", rs.filter((r) => r.ok).length === 100 && Number(await store.get("quota")) === 1000);
}

// ───────────────────────────────────────────────────────────────
title("6. 拒绝时的 HTTP 语义");
{
  const rl = new RateLimitedError("queue_full", 7).toHttp();
  const qe = new QuotaExceededError("user_daily", Date.UTC(2026, 9, 25)).toHttp();
  const co = new CircuitOpenError("weekly-digest", Date.UTC(2026, 9, 25)).toHttp();
  console.log("  速率类  :", rl.status, JSON.stringify(rl.headers), rl.body.error.code);
  console.log("  额度类  :", qe.status, JSON.stringify(qe.headers), qe.body.error.code, (qe.body.error as any).reset_at);
  console.log("  断路器  :", co.status, JSON.stringify(co.headers), co.body.error.code);
  check("速率类 → 429 + Retry-After（可自动重试）", rl.status === 429 && rl.headers["Retry-After"] === "7");
  check("额度类 → 402 + 重置时间，无 Retry-After（不要诱导客户端重试）", qe.status === 402 && !("Retry-After" in qe.headers) && !!(qe.body.error as any).reset_at);
  check("断路器 → 409 + 恢复时间", co.status === 409 && !!(co.body.error as any).resume_at);
}

console.log(`\n${fail === 0 ? "ALL PASS ✅" : "FAILED ❌"}  (${pass} 通过, ${fail} 失败)`);
if (fail) process.exit(1);
