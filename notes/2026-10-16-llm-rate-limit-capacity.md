# LLM 容量估算与限流：周一高峰的 AI 代码评审

## 1. 场景

公司内部有个 AI 代码评审 Agent，每开一个 PR 就跑一次评审：

- 每次评审 **8 路 LLM 调用同时发出**，每次平均输入 6k token、输出 800 token；
- 供应商限额：**500 RPM、2M TPM**；
- 客服 Bot **共用同一个 key**，平时占掉约 30% 额度；
- 周一上午 10 点合并高峰：**10 分钟涌进约 300 个 PR**。

问题：会不会撞限额？先撞哪个？怎么调度，既不丢评审，又不拖垮客服 Bot？

## 2. Dong 的回答与点评

**① "会撞，token 先撞上。"** ✅ 判断正确，数字见第 3 节。补一句：平均值只是下限，8 路扇出加上 PR 扎堆到达，最忙那一分钟会比平均糟得多；如果 429 之后所有请求立刻重试，客服 Bot 会被一起挤掉。

**② "计算最大并发，然后限制池子大小。"** 方向对，是第一步，至少挡住了"8 路一起冲出去"。但**并发数 ≠ TPM 吞吐**：

- 单次耗时不固定：响应快时同样 20 个并发，每分钟跑完的 token 会更多，照样超限；
- 请求大小不同：一个 3 万 token 的大 PR 顶 5 个普通请求；
- 客服 Bot 不在你的池子里，你一跑满它照样吃 429。

更好的做法：**中心化的 RPM + TPM 双令牌桶**。请求前预估 token（输入可提前算，输出按 `max_tokens` 预留），扣额度；完成后按实际用量对账退回。再给客服 Bot 一个保底份额或更高优先级。

**③ "排队 20 分钟不能接受，没想到别的办法。"** 很正常，这正是今晚要补的。额度不变时只有两条路：**少用 token**，或者**把重要的排前面**（见第 4 节）。

**④ 你的顺序：排队 → 扩额度 → 改代码。** 按改动成本排是合理的直觉，但有两点要修正：

- 裁剪上下文、开提示词缓存（prompt caching）往往只是几行改动，却是 ROI 最高的一招——demo 里裁 40% 上下文，评审 p95 从 5.4 分钟降到 0.5 分钟；
- 扩额度要走预算、等供应商审批，周期以周计，解不了这周一的火。

更好的顺序：**马上上排队 + 优先级 → 同时做裁剪和缓存 → 并行申请独立 key / 提额**。

## 3. 容量估算

| 维度 | 需求（10 分钟平均） | 可用（扣掉客服 30%） | 结论 |
|---|---|---|---|
| 请求数 | 300 × 8 = 2400 次 → **240 RPM** | 500 × 70% = **350 RPM** | 够 |
| Token | 2400 × 6.8k ≈ 1630 万 → **≈1.63M TPM** | 2M × 70% = **1.4M TPM** | **超 16%** |

> 估算口诀：先算**平均**判断"会不会超"，再想**峰值**（扇出 × 突发）判断"超多少"。Agent 场景几乎总是 TPM 先撞，因为每次调用都塞了大段上下文。

峰值更糟：如果前 3 分钟到了一半的 PR，就是 150 × 8 × 6.8k ÷ 3 ≈ 2.7M TPM，比整个 key 的额度还高。

## 4. 关键判断与取舍

### 并发池 vs 令牌桶（取舍）

| | 并发池 | RPM+TPM 令牌桶 |
|---|---|---|
| 管住的 | 同时在跑几个 | 每分钟用多少 |
| 对齐供应商限额 | 否，随延迟漂移 | 是 |
| 大小请求 | 一视同仁 | 按 token 计价 |
| 实现成本 | 极低 | 需要预估 + 对账，多实例要放 Redis |

两者不互斥：令牌桶管额度，并发池防止压垮自己的进程/连接。

### 少用 token 的招数 vs 代价（取舍）

- **裁剪上下文 / 摘要共享**：只给每个专家看相关文件；或先做一次摘要，8 路共用。代价：摘要可能丢细节。
- **合并调用**：8 路合成 2–3 次，省掉重复的系统提示和 diff。代价：单次更长、出错时重试粒度变粗。
- **按 PR 大小路由**：小改动用小模型或少跑几路专家。代价：要维护路由规则，小模型可能漏问题。
- **缓存**：没改动的文件复用上次结论；系统提示开 prompt caching（部分供应商缓存命中不计或少计额度）。代价：缓存失效逻辑。

### 排好优先级

- 快要合并的 PR / 标了紧急的排前面，草稿 PR 延后（但要**老化提升**，防止永远饿死）；
- **先出关键结果再补全**：先跑安全、正确性两路，评论先发出去，其余几路慢慢补；
- 最后才是加资源：独立 key / 独立账号，从根上和客服 Bot 隔离。

## 5. Bad Case 翻车点

- **429 后立刻重试**：所有请求同一时刻重试 → 重试风暴，额度全被失败请求吃掉，客服 Bot 跟着 429。demo 的朴素模式：**34060 次 429，客服失败 374 次**。
- **每个实例各自限流**：3 台 worker 各自按 1.4M 限流，总量是 4.2M。限流状态必须集中（Redis / 网关 / 代理）。
- **只预估输入、不预留输出**：输出 token 也算 TPM，按 0 预留就会系统性超限；按 `max_tokens` 预留、事后退回才安全。
- **桶容量设成"一分钟的额度"**：瞬间放出一分钟的量，再叠加持续补充，60 秒滑动窗口里实际能到 2 倍限额。桶容量取几秒的量，并留 10% 安全余量。
- **低优先级永远饿死**：严格优先级下草稿 PR 可能一直排不上，要有老化（等待超过 N 分钟提升优先级）。
- **把超时当失败去重试写操作**：超时可能其实成功了（见 6.4）。

## 6. 深入讨论

### 6.1 预估 + 对账怎么做

```ts
const est = countTokens(prompt) + maxTokens;   // 输入可精确算，输出按上限预留
await limiter.acquire({ rpm: 1, tpm: est });  // 不够就排队
const res = await llm.call(prompt, { maxTokens });
limiter.refund(est - res.usage.total_tokens); // 用多少算多少，多的退回
```

对账让桶里的额度贴近真实用量；不对账的话每次都按上限扣，额度利用率会偏低。

### 6.2 尊重 Retry-After + 抖动指数退避

```ts
const wait = Math.max(retryAfterMs, Math.random() * Math.min(30_000, 1000 * 2 ** attempt));
```

- 供应商告诉你"多久后再来"，就至少等这么久；
- **全抖动（full jitter）**：把大家的重试时间打散，避免同一时刻一起冲；
- 每个调用最多重试 3–4 次。

### 6.3 重试预算与熔断

- **重试预算**：全局重试次数不超过"请求数 × 10% + 常数"。故障时重试被限住，额度留给新请求；
- **熔断**：错误率超过阈值就打开，一段时间内直接快速失败或切**备用模型/备用供应商**，半开状态放少量探测请求，恢复了再关闭；
- 两者配合：预算防"自己把自己压垮"，熔断防"对方已经挂了还一直打"。

### 6.4 超时可能已经成功

LLM 调用超时，供应商那边可能已经算完并计费了。对纯读/计算的调用，重试只是多花钱、多吃额度（要把这次的 token 也算进桶里）；对会写外部状态的步骤（比如往 PR 发评论），重试前要么带幂等键（`task_id + step`），要么先查一下是不是已经写过。

### 6.5 裁剪上下文具体怎么做

目标：每个专家只看**和它有关、真正改了的**那部分代码。按收益从高到低：

**① 只给 diff，不给整文件。** `git diff -U3 base...head` 只带改动行和上下 3 行，通常比整文件小一个数量级。

**② 过滤掉没人需要评审的文件**（锁文件、压缩产物、快照、生成代码、图片）：

```ts
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$|\.min\.(js|css)$|\.snap$|(^|\/)(dist|build|generated|__generated__)\/|\.(pb|gen)\.\w+$|\.(png|jpe?g|gif|svg|ico|webp|pdf)$/i;
const files = parseDiff(diff).filter(f => !SKIP.test(f.path));
```

**③ 按专家路由文件。** 安全专家看 `auth/`、SQL、依赖变更；性能专家看循环、查询、热路径；测试专家看 `*.test.*` 和对应的实现文件。8 个专家不再各自吞下整个 diff。

**④ 符号上下文按需补。** 只有 diff 不够理解时（改了某函数的调用方），再用 AST（tree-sitter / ts-morph）或 `grep -n "function foo"` 补被调函数的签名和几行定义，而不是把整个文件塞进去。

**⑤ token 预算 + 按风险挑选，超出的写摘要：**

```ts
const BUDGET = 4000; // 每个专家的输入预算
const risk = (f: FileDiff) =>
  (/auth|payment|sql|crypto|permission/i.test(f.path) ? 10 : 0) + f.added + f.removed;
let used = 0; const full: FileDiff[] = [], overflow: FileDiff[] = [];
for (const f of files.sort((a, b) => risk(b) - risk(a))) {
  const t = countTokens(f.patch);
  if (used + t <= BUDGET) { full.push(f); used += t; } else overflow.push(f);
}
const context = [
  ...full.map(f => f.patch),
  overflow.length ? `其余 ${overflow.length} 个文件摘要：\n` + overflow.map(f => `- ${f.path}: +${f.added}/-${f.removed}`).join("\n") : "",
].join("\n");
```

**⑥ 一份便宜模型做的摘要，所有专家共享。** 先用小模型生成"这个 PR 改了什么、为什么改"的 300 token 摘要，8 个专家都带上它，代替各自重复读一遍 PR 描述和整段 diff。

> 一次裁剪的效果，用 demo 的 C 模式可以直观看到：输入少 40%，评审 p95 从 5.4 分钟降到 0.5 分钟。

#### Bad Case：裁过头

裁得太狠，模型看不到被调函数的实现、看不到已有的校验逻辑，就会报"这里没做空值检查"这类**误报**，开发者很快就不再信任评审结果。所以裁剪要当成一次需要评估的改动：抽 50 个历史 PR，用"完整上下文"和"裁剪后"各跑一遍，对比发现的真问题数、误报数和 token 用量，确认质量没降再全量上。

**复习题 6.5：一个 PR 改了 `package-lock.json`（2 万行）、3 个业务文件和 1 张图片，你会怎么构造安全专家的上下文？**

<details><summary>参考答案</summary>

- 锁文件和图片直接过滤；但锁文件里**依赖版本变更**对安全专家有价值，可以只提取"新增/升级了哪些包"这一行级摘要，而不是 2 万行；
- 3 个业务文件按风险排序（涉及 auth/SQL 的优先），给 `-U3` 的 diff；
- 如果改动调用了外部函数，用 AST/grep 补被调函数签名；
- 超出预算的文件只给路径和增删行数摘要，再加一份共享的 PR 摘要；
- 上线前用历史 PR 抽样对比，确认没有因为裁剪引入误报或漏报。

</details>

### 6.6 令牌桶怎么实现 + 输出怎么预估

完整可运行版本见 demo 的 [`limiter.ts`](https://github.com/sdxzy/arch-notes/blob/main/demos/2026-10-16-llm-rate-limit-capacity/limiter.ts)。核心只有三个动作：**补充（refill）、扣减（take）、对账（settle）**。

```ts
class TokenBucket {
  private tokens: number; private last = Date.now();
  constructor(private capacity: number, private perMinute: number) { this.tokens = capacity; }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
    this.last = now;
  }
  tryTake(n: number) { this.refill(); if (this.tokens < n) return false; this.tokens -= n; return true; }
  settle(reserved: number, actual: number) { this.tokens = Math.min(this.capacity, this.tokens + reserved - actual); }
}
```

**双桶包装：先预留，再按 usage 对账。**

```ts
const rpm = new TokenBucket(500 * 0.7 / 12, 500 * 0.7 * 0.9);         // 容量 = 5 秒的量，速率留 10% 余量
const tpm = new TokenBucket(2e6 * 0.7 / 12, 2e6 * 0.7 * 0.9);
let pausedUntil = 0;

async function callLLM(prompt: string, maxTokens: number) {
  const reserve = countTokens(prompt) + maxTokens;
  while (Date.now() < pausedUntil || !(rpm.tryTake(1) && (tpm.tryTake(reserve) || (rpm.settle(1, 0), false))))
    await sleep(200);                                     // 两个桶都够才放行；TPM 不够就把 RPM 退回
  try {
    const res = await llm.chat({ prompt, max_tokens: maxTokens });
    tpm.settle(reserve, res.usage.prompt_tokens + res.usage.completion_tokens); // 多退少补
    return res;
  } catch (e: any) {
    if (e.status === 429) pausedUntil = Date.now() + Number(e.headers["retry-after"] ?? 1) * 1000; // 整个桶暂停
    tpm.settle(reserve, 0);  // 未被处理（超时除外：超时可能已计费，应保守地不退）
    throw e;                 // 交给外层的退避 + 重试预算
  }
}
```

**多台机器：Redis + Lua 原子扣减。** 内存桶只在单进程有效，多实例要把桶放进 Redis，用一段 Lua 让"补充 + 判断 + 扣减"原子执行：

```lua
-- KEYS[1]=桶 key  ARGV: capacity, perMs, now, n
local b = redis.call('HMGET', KEYS[1], 'tokens', 'last')
local cap, rate, now, n = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local tokens = math.min(cap, (tonumber(b[1]) or cap) + (now - (tonumber(b[2]) or now)) * rate)
local ok = tokens >= n
if ok then tokens = tokens - n end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'last', now)
redis.call('PEXPIRE', KEYS[1], 120000)
return ok and 1 or 0
```

不想自己写，就用 `rate-limiter-flexible` 的 `RateLimiterRedis`，`consume(key, points)` 里的 points 填 token 数；对账时多退用 `reward(key, points)`、少补用 `penalty(key, points)`。

**客服 Bot 的保底：** 给它单独一个 30% 的桶，自己的用完了再以最高优先级借共享桶；评审和草稿只能用共享桶。demo 里就是 `Pool("cs-reserved")` + `Pool("shared")` + `Scheduler`。

**429 时暂停整个桶：** 一个请求收到 429 + Retry-After，说明整把 key 已经满了，**同一时刻其他请求也会撞墙**。所以要暂停整个桶到 Retry-After 之后，并把补充速率下调（AIMD：每次 429 乘 0.9，平稳后再慢慢恢复），而不是只让这一个请求退避。

#### 输出 token 怎么预估

- **按 `max_tokens` 预留**：它是**硬上限**，供应商不会让输出超过它，所以按它预留，桶永远不会被超支；事后用 `usage` 退回差额。
- **`max_tokens` 别一律填 4096**：按调用类型统计历史输出的 **P95** 来定（比如安全专家 P95 是 600，就设 700）。填 4096 会让每次预留虚高 3000+，桶里明明有额度却放不进请求，吞吐被白白压低。
- **约束输出格式**：要求返回 JSON、"最多 5 条问题，每条不超过 2 句"，输出长度就稳定了，P95 也更低。
- **永远用 `usage` 对账**：不管预估多准，最后都以供应商返回的 `usage` 为准；流式输出要打开 `stream_options.include_usage` 之类的选项拿到最终用量。

#### demo 实测：估算和供应商记账不一致时

供应商的计数可能比你估的多（分词器不同、隐藏系统提示、图片 token 等）。demo 加了 **D 模式**：mock 供应商对每次请求多记 15%（`VENDOR_SKEW=1.15`，可改）。

| D 模式 | 429 | 重试预算拒绝 | 最终失败（客服） | 评审 PR 完成 p95 | 全部评完 |
|---|---|---|---|---|---|
| `npx tsx sim.ts`（429 时暂停整桶 + AIMD 降速） | **6** | 0 | **0 (0)** | 11.4min | 21.9min |
| `NO_PAUSE=1 npx tsx sim.ts`（只退避单个请求） | **1093** | **711** | 711 (90) | 1.1min | 10.3min |

> 看点：只退避单个请求时，后面的请求还在不停撞墙，重试预算很快耗尽，711 次调用直接失败（其中客服 90 次）——重试预算防住了重试风暴，但代价是丢请求。暂停整桶 + 降速后只撞了 6 次 429、零失败，代价是排队变长。生产里还要配合**定期用 `usage` 校准估算系数**，把偏差从根上消掉。

**复习题 6.6：你把所有调用的 `max_tokens` 都设成 4096，实际平均输出 800。会发生什么？怎么改？**

<details><summary>参考答案</summary>

- 不会超限（预留的是硬上限），但每次多预留约 3300 token，在 TPM 桶里"占着不用"：在 1.4M TPM 下，同时能放行的请求数被压到原来的 1/5 左右，排队变长，直到请求完成对账才释放；
- 改法：按调用类型统计历史输出 P95，`max_tokens` 设成 P95 加一点余量；
- 用 JSON 格式和"最多 5 条"这类约束让输出更短、更稳定；
- 每次都用 `usage` 对账，并监控"预留/实际"的比值，偏离太大就调整。

</details>

## 7. Review 审方案清单 与成熟工具

**审 AI 交出来的限流方案时问：**

1. 限的是 RPM 还是 TPM？有没有两个都限？
2. 限流状态是不是集中的？多实例会不会各算各的？
3. 输出 token 有没有预留？有没有按实际用量对账？
4. 429 时是否读 Retry-After、有没有抖动、有没有重试上限和重试预算？
5. 和其他业务共用 key 时，谁保底、谁先让？
6. 低优先级会不会被饿死？
7. 有没有监控：每分钟 token 用量、429 率、排队时长 p95？

**成熟工具：**

- **LiteLLM Proxy**：放在所有调用前面的代理，按 key/团队/模型设 RPM、TPM 限额和预算，支持多 deployment 负载均衡、失败回退（fallbacks）、按用量路由。最适合"多个业务共用供应商 key"的场景：给客服 Bot 和评审 Agent 各发一个虚拟 key，各自限额。
- **Redis 限流库**：Node 的 `rate-limiter-flexible`（`RateLimiterRedis` 可按 points 扣减，points 就是 token 数）、`Bottleneck`（带 Redis 集群模式、`reservoir` 额度、优先级、`weight` 按权重扣减）；自己写的话就是 Redis + Lua 原子扣减。
- **API 网关**：Kong、Envoy、云厂商 AI Gateway（如 Cloudflare AI Gateway）提供限流、缓存、重试和观测，适合统一出口。
- **供应商 Batch API**：OpenAI / Anthropic 的批处理接口 24 小时内完成，通常半价且额度独立。草稿 PR、夜间全仓扫描这种不急的活放进去，直接把峰值削掉。
- **Prompt caching**：Anthropic、OpenAI 等都支持，长系统提示 + 规则说明命中缓存后更便宜、更快。

## 8. Demo：双桶限流器模拟周一高峰

`limiter.ts` 实现了 RPM+TPM 双令牌桶（预估扣减 + 对账）、三条优先级道（客服保底池 + 高优先级借共享池、评审普通、草稿低并带 5 分钟老化）、重试预算和退避；`sim.ts` 用虚拟时钟模拟 300 个 PR 的高峰，mock 供应商用 60 秒滑动窗口记账，超限返回 429 + Retry-After。运行：`npx tsx sim.ts`。

实测输出（摘要）：

| 模式 | 429 次数 | 客服失败 | 评审排队 p50/p95 | 评审 PR 完成 p95 | 全部评完 |
|---|---|---|---|---|---|
| A 朴素：并发池 64 + 1 秒立即重试 | 34060 | **374** | 0 / 0.1min | 1.5min（但 212 次评审调用最终失败） | 10.2min |
| B 双桶限流 + 优先级 + 退避 | **0** | **0** | 0.4 / 5.2min | 5.4min | 14.5min |
| C 限流 + 裁剪 40% 上下文 | 0 | 0 | 0 / 0.3min | 0.5min | 10.2min |
| D 限流，但供应商多记 15% | 6 | 0 | 1.8 / 11.2min | 11.4min | 21.9min |

D 模式（以及 `NO_PAUSE=1` 的对照）见 6.6 节。

> 看点：A 看起来"快"，是因为它把客服 Bot 的额度抢走了，还丢了几百次调用；B 不丢任何请求、客服排队 p95 为 0 秒，代价是评审排队几分钟、草稿被推到 5 分钟后；C 说明"改几行代码裁上下文"比任何调度技巧都管用。

## 9. 复习题

**1. 每次调用输入 10k、输出 1k，供应商 1000 RPM / 3M TPM，客服占 20%。每分钟最多能跑多少次评审调用？先撞哪个？**

<details><summary>参考答案</summary>

- 可用：800 RPM、2.4M TPM；
- 每次 11k token，TPM 限制下最多 2.4M ÷ 11k ≈ **218 次/分钟**，远低于 800 RPM，所以**先撞 TPM**；
- 如果按 `max_tokens`（比如 2k）预留而不对账，就只剩 2.4M ÷ 12k = 200 次——这就是对账的价值。

</details>

**2. 为什么"限制最大并发 = 20"不能保证不超 TPM？举两个反例。**

<details><summary>参考答案</summary>

- 供应商变快：每次从 10 秒降到 3 秒，同样 20 并发，每分钟完成的调用从 120 次变成 400 次，token 翻了 3 倍多；
- 请求变大：一批 3 万 token 的大 PR 进来，20 并发的 token 量是平时的 5 倍；
- 另外，其他共用 key 的业务不在这个池子里。并发池管"同时几个"，TPM 管"每分钟多少"，要用 token 计价的令牌桶对齐。

</details>

**3. 3 台 worker 各自在内存里用令牌桶限到 1.4M TPM，会发生什么？怎么改？**

<details><summary>参考答案</summary>

- 总额度变成 4.2M，照样 429；按 1.4M ÷ 3 平分又会在负载不均时浪费额度；
- 改法：限流状态集中——Redis + Lua 原子扣减（`rate-limiter-flexible`、Bottleneck 集群模式），或者所有调用都过 LiteLLM Proxy / API 网关，由它统一限流。

</details>

**4. 供应商大面积返回 429 和 5xx，你的重试策略应该包含哪几层？各防什么？**

<details><summary>参考答案</summary>

- **Retry-After**：对方说多久，就至少等多久；
- **指数退避 + 全抖动**：打散重试时间，防止同一时刻一起冲；
- **单请求重试上限**（3–4 次）：防无限重试；
- **全局重试预算**（请求数 × 10%）：防重试风暴把额度吃光、挤掉客服 Bot；
- **熔断 + 备用模型**：对方真挂了就快速失败或切换，半开探测后再恢复。

</details>

**5. 评审 Agent 往 PR 发评论那一步超时了，要不要重试？**

<details><summary>参考答案</summary>

- 超时 ≠ 失败，评论可能已经发出去了，直接重试会发两条；
- 重试前先查 PR 上有没有这次任务的评论（评论里带 `task_id` 标记），或者用"更新同一条评论"代替"新建评论"，让操作天然幂等；
- 而 LLM 调用超时可以直接重试，代价只是钱和额度，但要把那次的 token 也记进限流桶里。

</details>

**6. 额度不变，周一高峰排队 20 分钟。按投入产出排序，你会先做什么？**

<details><summary>参考答案</summary>

- 立刻：排队 + 优先级（快合并的先评、草稿延后或丢进 Batch API），先出安全/正确性两路结果；
- 同时：裁剪上下文 / 摘要共享、开 prompt caching——几行改动，demo 里裁 40% 让评审 p95 从 5.4 分钟降到 0.5 分钟；
- 并行：申请独立 key 或提额，和客服 Bot 彻底隔离；但这要走预算和审批，不能指望它解当下的火。

</details>
