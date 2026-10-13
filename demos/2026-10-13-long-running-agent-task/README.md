# 长程 Agent 任务设计：「AI 写周报」从前端到后端

> 日期：2026-10-13 ｜ 标签：长任务、幂等、可靠性、SSE、Agent 编排

## 1. 场景

用户点击「生成周报」，Agent 读取他一周的 Git 提交和日历，生成周报，耗时 **30 秒 ~ 2 分钟**。要设计前端 → 后端的完整链路。

## 2. 你的回答与评价

**你的方案**：点击触发异步任务 → 后端新建一条状态记录 → 任务完成后回调更新状态 → 前端轮询或接收推送拿结果。推送和轮询二选一时你选了**轮询**，理由是「推送要维护连接，连接多了服务端压力大」。

**评价**
- ✅ 骨架正确：异步任务 + 状态记录，不让 HTTP 请求干等。这是长任务的标准形态。
- ⚠️ 漏了四个真正会出事的点：重复触发、任务僵死、中间进度、局部失败恢复。
- ⚠️ 推送/轮询的取舍判断反了：高估了 SSE 连接成本，低估了大规模轮询的成本。

## 3. 关键判断与取舍

### 3.1 幂等：连点两下 = 两个任务？
前端为「一次点击意图」生成 `Idempotency-Key`（UUID），后端用 key → taskId 映射（真实系统：DB 唯一索引 + TTL）。同一个 key 再来，直接返回已有任务。
- 边界：key 要由**客户端**生成，并且重试时复用同一个；服务端生成就失去意义了。
- 并发下用唯一约束保证，不能「先查再插」（会有竞态）。

### 3.2 不能只靠「完成回调」更新状态
进程崩了、模型调用卡住，回调**永远不会来**，任务永远「running」。
- **心跳**：执行中定期写 `heartbeatAt`。
- **清扫器（sweeper）**：定时扫描 `running && now - heartbeatAt > 阈值` 的任务，标记为 failed（或重新入队）。
- **整体超时**：给每步和整个任务设上限。
- 原则：**状态机的终态不能只依赖「乐观路径」上的某个事件。**

### 3.3 分步进度 + SSE
只有「开始 / 结束」两个状态，进度条就是假的。Agent 天然是多步的：按步骤上报（读取提交 → 读取日历 → 生成中），后端持久化，前端用 SSE 实时显示，生成阶段甚至可以流式输出 token。

### 3.4 Checkpoint：失败只重试失败那步
每步结果持久化。日历接口挂了，重试时跳过已完成的「读取 Git」，只重跑失败的步骤，省时间也省模型调用费。每步自身要可重入（重跑不会产生副作用）。

### 3.5 推送 vs 轮询：怎么判断
| 维度 | SSE 推送 | 轮询 |
|---|---|---|
| 资源成本 | 空闲长连接，单机数万级没问题（前提：异步 IO，别一连接一线程） | 1 万用户 × 每 2 秒 = **5000 QPS**，绝大多数返回「还没好」，压在 DB 上 |
| 实时性 | 毫秒级 | 取决于间隔 |
| 基础设施 | 需要网关/代理支持长连接，Serverless 可能掐断 | 哪都能跑 |
| 断线 | 要处理重连 | 天然无状态 |

**判断三要素**：① 任务时长与实时性要求（2 分钟 + 要看进度 → 推送；几小时批处理 → 30 秒轮询足够）；② 基础设施是否支持长连接；③ 断线兜底方案。
**本题结论**：SSE 为主通道，断线后先 `GET /tasks/:id` 对齐一次状态，再降级轮询。

## 4. Bad Case 清单
- [ ] 连点 / 网络重试产生重复任务（没有幂等键，或 key 由服务端生成）
- [ ] 进程崩溃后任务永远 running（只靠完成回调）
- [ ] 进度条只有 0% 和 100%
- [ ] 第 3 步失败导致前两步（含昂贵的 LLM 调用）全部重跑
- [ ] 重试无上限、无退避，把挂掉的上游打得更死
- [ ] SSE 经过 Nginx/网关被缓冲或 60 秒空闲断开（要关缓冲 + 心跳注释行 `: ping`）
- [ ] SSE 断线后前端停在旧状态（重连时没有重新拉快照）
- [ ] 清扫器把「其实还活着、只是慢」的任务判死，然后它又写回 succeeded（要用状态版本号/条件更新防覆盖）
- [ ] 大规模短间隔轮询直接打 DB

## 5. 如何 Review AI 给出的方案
拿到 Agent 设计的长任务方案时，逐条追问：
1. **重复提交会怎样？** 幂等键谁生成、存哪、并发下靠什么保证唯一？
2. **执行进程突然死掉，状态最终会变成什么？** 由谁、在多久后发现？
3. **第 N 步失败，重试从哪开始？** 中间结果存在哪？每步可重入吗？
4. **进度怎么来的？** 是真实步骤还是假进度条？
5. **为什么选推送/轮询？** 算过连接数和 QPS 吗？部署环境支持长连接吗？断线后怎么恢复？
6. **重试策略**：上限、退避、哪些错误不该重试？

## 6. 复习题
1. 用户点击后网络超时，前端自动重试了一次。你的系统如何保证只有一个任务？key 应该在什么时机生成？
2. 清扫器把一个「卡了 10 秒但其实还活着」的任务标成 failed，随后该任务完成并写入 succeeded。会发生什么？怎么防？
3. 部署在只支持 30 秒请求超时的 Serverless 平台上，你会怎么调整这套方案？
4. 「生成周报」这一步调用 LLM 失败了，重试时应该复用前两步的结果吗？如果用户这期间又提交了新代码呢？
5. 5 万并发用户同时在等任务，分别估算 SSE 与 3 秒轮询的资源开销。

## 7. 深入讨论：幂等到底怎么做

> 来自当晚的追问：幂等键什么时候生成？是不是必须？下单怎么做？没有天然 ID 怎么办？

### 7.1 幂等键什么时候生成：跟「意图」绑定，不跟「点击」绑定
- **页面或表单打开时**生成 key，代表「这一次想做这件事」。
- **重试时复用**同一个 key（超时重试、断网重发）。
- **轮换时机**：成功之后、参数变了（比如换了周次）、用户明确点了「重新生成」。

三层分工，各管各的：
| 层 | 解决什么 |
|---|---|
| 前端 loading / 禁用按钮 | 防止**发两次** |
| 幂等键 | 发了两次也只**算一次** |
| 后端业务规则（唯一约束） | 兜底刷新页面、多标签页这类前端管不到的情况 |

### 7.2 翻车：每次点击都生成新 UUID
- [ ] `onClick = () => fetch(url, { headers: { "Idempotency-Key": crypto.randomUUID() } })`：每次都是新 key，重试变成新请求，幂等形同虚设
- [ ] 以为「按钮 loading 了就不会重复」：超时后其实请求已成功、用户刷新或开了多个标签页、网关和客户端自动重试，loading 都拦不住

### 7.3 取舍：幂等键是不是必须的
不是。**按「重复执行一次的代价」来判断**：
- **周报**：重复生成只是多花一点模型调用的钱，用业务规则去重（同一用户同一周只保留一个进行中的任务）就够了。
- **支付、下单、发消息、改外部状态的 Agent 工具调用**：重复一次就是真实损失或对外可见的副作用，**必须**做幂等。

### 7.4 下单：订单号就是天然的幂等键
1. 先创建订单（状态「待支付」），拿到订单号；
2. 再用订单号去支付。同一个订单号重复支付，只会成功一次。

两个要注意的地方：
- **建单本身也会重复**：提前下发一个 order token（打开结算页时生成，建单时校验并消费），或者容忍重复，靠超时自动关闭未支付订单来清理。
- **支付回调会重复到达**：用状态机加条件更新，只有第一次生效：
```sql
UPDATE orders SET status = 'paid', paid_at = now()
WHERE id = :order_id AND status = 'pending';
-- 影响行数 = 0：说明已处理过，直接返回成功，不要重复发货
```

### 7.5 没有天然 ID：自己构造业务唯一键
周报：`user_id + 周次`，比如 `user_123:2026-W42`。
- **DB 唯一索引**（可以只约束「进行中」的任务），冲突时返回已有任务：
```sql
CREATE UNIQUE INDEX uniq_active_report ON report_tasks (biz_key)
  WHERE status IN ('queued', 'running');

INSERT INTO report_tasks (id, biz_key, status) VALUES (:id, 'user_123:2026-W42', 'queued')
ON CONFLICT (biz_key) WHERE status IN ('queued', 'running') DO NOTHING
RETURNING id;
-- 没返回行：SELECT id FROM report_tasks WHERE biz_key = ... AND status IN ('queued','running')
```
- 或者用 **Redis 锁**：`SET report:user_123:2026-W42 <taskId> NX EX 600`。
- 「重新生成」走单独的接口或带 `force` 参数，不要让它和幂等逻辑混在一起。

更多例子：日报 = 用户 + 日期；审批 = 单据 + 审批人 + 节点；发消息 = 会话 + 客户端消息 ID。

### 7.6 Review 追问：幂等
- **这个操作重复执行一次，最坏会怎样？**（决定要不要做幂等、做到哪一层）
- 幂等键在什么时候生成、什么时候轮换？刷新页面或开多个标签页时，靠哪一层兜底？
- 回调或消息重复到达时，状态更新是不是条件更新？

## 8. 深入讨论：心跳与清扫器怎么实现

> 来自当晚的追问：心跳具体怎么打？清扫器跑在哪？多实例会不会打架？

### 8.1 心跳：一个字段加一个定时器
任务表加一列 `heartbeat_at`。worker 开始执行时启动定时器，每 10 秒更新一次，在 `finally` 里清掉：
```ts
async function runTask(taskId: string) {
  const beat = setInterval(() =>
    db.query(`UPDATE tasks SET heartbeat_at = now() WHERE id = $1 AND status = 'running'`, [taskId]), 10_000);
  try {
    await doSteps(taskId);
  } finally {
    clearInterval(beat);
  }
}
```
另一种写法是**按步骤打心跳**，和进度写入合并成一条 UPDATE：`SET step = $2, heartbeat_at = now()`。

为什么可靠：**进程崩了，定时器自然就停了**，心跳不再更新，清扫器就能发现。这不依赖任何「完成回调」。

### 8.2 翻车：活着，但没在干活
- [ ] 模型调用卡住（连接挂起、无限等待），`setInterval` 却照常在跳，任务永远「看起来还活着」。解法：**每步设超时**（`AbortSignal.timeout(60_000)`），或者只按步骤打心跳，让心跳反映的是「有进展」，而不只是「进程还在」

### 8.3 清扫器：条件更新 + 跑在 worker 之外
每 30 秒执行一次：
```ts
setInterval(async () => {
  const { rows } = await db.query(`
    UPDATE tasks SET status = 'failed', error = 'heartbeat timeout'
    WHERE status = 'running' AND heartbeat_at < now() - interval '60 seconds'
    RETURNING id`);
  for (const r of rows) notify(r.id);   // 通过 SSE / 消息通知前端
}, 30_000);
```
- **必须跑在 worker 之外**：放在 API 服务、独立进程，或者 cron / K8s CronJob 里。worker 自己挂了，谁来扫它？
- **多实例**：条件 UPDATE 天然安全，同一行只会被一个实例改成功。但如果要做「重新入队」这类副作用，就得加锁，或者用 `SELECT ... FOR UPDATE SKIP LOCKED` 认领：
```sql
SELECT id FROM tasks
WHERE status = 'running' AND heartbeat_at < now() - interval '60 seconds'
FOR UPDATE SKIP LOCKED LIMIT 50;
```

### 8.4 取舍：超时阈值怎么定
阈值取**心跳间隔的 3 到 6 倍**（10 秒心跳 → 30 到 60 秒）。
- 太短：GC 停顿、网络抖动、DB 慢一下，就误杀活着的任务。
- 太长：任务真挂了，用户要等很久才看到失败。

### 8.5 翻车：僵尸复活
- [ ] worker 只是卡了一会儿，被清扫器标成 failed 之后又醒过来，把结果写成 succeeded，甚至重复发了通知。解法：**worker 的每次写入都带 `WHERE status = 'running'`，影响行数为 0 就立刻退出**：
```ts
const r = await db.query(
  `UPDATE tasks SET step = $2, heartbeat_at = now() WHERE id = $1 AND status = 'running'`, [taskId, step]);
if (r.rowCount === 0) throw new Error("task no longer owned, abort");
```

### 8.6 取舍：清扫器用 cron / CronJob，还是常驻进程
**cron / K8s CronJob**：写成**一次性脚本**，里面没有 `setInterval`，跑一次就退出。调度和失败重启都交给平台：
```ts
// sweep.ts：每次被调度时执行一次
const { rows } = await db.query(`
  UPDATE tasks SET status = 'failed', error = 'heartbeat timeout'
  WHERE status = 'running' AND heartbeat_at < now() - interval '60 seconds'
  RETURNING id`);
console.log(JSON.stringify({ event: "sweep", zombies: rows.length }));  // 打点，供监控告警
for (const r of rows) await notify(r.id);
await db.end();
```
```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: task-sweeper }
spec:
  schedule: "* * * * *"          # 每分钟一次（cron 最小粒度）
  concurrencyPolicy: Forbid      # 上一次还没跑完，就不启动新的
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers: [{ name: sweeper, image: my-app, command: ["node", "sweep.js"] }]
```
**常驻进程**（自己跑 `setInterval`）：必须交给 **pm2 / systemd / K8s Deployment** 托管，崩了能自动拉起来。

不管哪种，下面两件事都要自己负责：
- **监控告警**：记录每轮扫到的僵尸任务数，数量突增就告警（通常说明 worker 大面积出问题了）。
- **防重叠**：`concurrencyPolicy: Forbid`，或者依赖条件 UPDATE 本身的幂等性。
- [ ] 翻车：清扫器自己挂了，又没人知道，结果所有僵尸任务都没人管。

### 8.7 任务自身超时 vs 清扫器：谁管什么
- **任务自己执行最大超时**：用 `AbortController` 或 `Promise.race` 设截止时间，到点后把自己标成 failed 并退出。这时状态已经不是 running，清扫器的 `WHERE status = 'running'` 就不会再命中它。
```ts
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 5 * 60_000);   // 整个任务最多跑 5 分钟
try {
  await doSteps(taskId, { signal: ac.signal });           // 每步把 signal 传给 fetch / 模型 SDK
} catch (e) {
  if (ac.signal.aborted)
    await db.query(`UPDATE tasks SET status = 'failed', error = 'deadline exceeded'
                    WHERE id = $1 AND status = 'running'`, [taskId]);
  throw e;
} finally { clearTimeout(timer); }
```
- **清扫器**兜底的是任务**来不及自己收尾**的情况：进程崩溃、机器断电、被 OOM 杀掉。
- 可选：清扫器同时把超过 `deadline_at` 的 running 任务也标成 failed（多一层保险）。
- 原则：**清扫器只改数据库状态，不去杀进程**。真正停下 worker，靠的是下面这条规则。

### 8.8 翻车防护：条件更新（CAS）为什么能防住「僵尸复活」
场景：worker A 卡了 90 秒，清扫器已经把任务标成 failed，前端也显示了失败，用户点了重试，新的 worker B 开始跑。这时 A 醒过来，准备写「第 3 步完成」。

如果 A 执行的是 `UPDATE ... WHERE id = $1`，就会覆盖 B 的状态，甚至把 failed 改回 succeeded。正确做法是**「比较并交换」(Compare-And-Swap)**：只有状态仍是我预期的值，这次写入才生效。
```ts
const r = await db.query(
  `UPDATE tasks SET step = $2, heartbeat_at = now()
   WHERE id = $1 AND status = 'running' AND attempt = $3`,   // attempt：重试时 +1，防 A 误写 B 的那一轮
  [taskId, step, myAttempt]);
if (r.rowCount === 0) {            // 状态已被别人改了：我已不再是这个任务的主人
  ac.abort();                      // 停掉手上的工作
  return;                          // 立刻退出，不写结果、不发通知
}
```
同一个思路在别处也见过：
- **乐观锁**：`UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`，影响 0 行就说明有人先改了。
- **支付回调**（7.4）：`WHERE status = 'pending'`，重复回调只有第一次生效。

说到底都是一件事：**把「检查」和「写入」合成一条原子语句，不要先 SELECT 再 UPDATE。**

### 8.9 生产环境：别自己造轮子
**BullMQ**（自带 stalled job 检测）、**Temporal**（activity 心跳 + 超时 + 重试一体）、**Celery**（`acks_late` + visibility timeout）都内置了这套机制。手写版适合理解原理，或者只用于很轻量的场景。

### 8.10 Review 追问：心跳与清扫
- **如果 worker 进程「活着但卡住了」，系统多久能发现？靠什么发现？**
- 任务被判定失败之后，原来的 worker 醒过来再写结果，会发生什么？
- 清扫器部署了几个实例？除了改状态，它还有没有别的副作用？
- **清扫器自己挂了，多久会有人知道？** 任务到了截止时间，是任务自己收尾，还是等清扫器来处理？

## 9. 最佳实践与成熟框架

### 9.1 Review 清单：长程任务 7 条最佳实践
1. **接口立即返回 + 队列/worker 执行**：接口只负责建任务、返回 202 和 taskId，不在请求里干活。
2. **按代价去重**：便宜的操作，用业务唯一键 + 唯一索引去重就够了；昂贵或有副作用的操作，再加幂等键。
3. **状态机**：`queued → running → succeeded / failed / cancelled`，所有状态转换都用条件更新。
4. **分步 checkpoint + 重试**：只重试失败的那一步，用指数退避，并设重试上限。
5. **三层保险**：单步超时、任务整体截止时间、心跳 + 清扫器。
6. **进度通道**：SSE 为主，轮询兜底，重连时先拉一次快照对齐状态。
7. **可观测**：盯任务耗时、失败率、僵尸任务数、队列积压，并配好告警。

### 9.2 BullMQ（Node + Redis）
- `jobId` 去重：同一个 jobId 不会重复入队，可以直接用业务唯一键。
- `attempts` / `backoff`：自带重试和退避。
- `job.updateProgress()` 上报进度，`QueueEvents` 监听后转发成 SSE。
- 内置 **stalled job 检测**：worker 的锁过期，任务会被重新处理。这相当于心跳 + 清扫器。
- **仍需自己写**：单步超时、分步 checkpoint（可以存在 `job.data` 或 DB 里）。
```ts
import { Queue, Worker, QueueEvents } from "bullmq";
const connection = { host: "localhost", port: 6379 };
const queue = new Queue("report", { connection });

// 入队：jobId = 业务唯一键，重复调用不会产生第二个任务
await queue.add("weekly", { userId: "u123", week: "2026-W42" },
  { jobId: "u123:2026-W42", attempts: 3, backoff: { type: "exponential", delay: 2000 } });

new Worker("report", async job => {
  const steps = ["git", "calendar", "generate"];
  const done: Record<string, unknown> = job.data.checkpoints ?? {};
  for (const [i, s] of steps.entries()) {
    if (done[s]) continue;                                    // checkpoint：跳过已完成的步骤
    done[s] = await runStep(s, AbortSignal.timeout(60_000));  // 单步超时
    await job.updateData({ ...job.data, checkpoints: done });
    await job.updateProgress(Math.round(((i + 1) / steps.length) * 100));
  }
  return done.generate;
}, { connection });

// 进度转发：QueueEvents → 推给对应任务的 SSE 订阅者
new QueueEvents("report", { connection })
  .on("progress", ({ jobId, data }) => sse.push(jobId, { progress: data }));
```

### 9.3 Temporal（持久化工作流）
- 每一步写成 **Activity**，执行结果由框架**自动持久化**。进程崩了，换台机器从断点继续，checkpoint 不用自己写。
- 每个 Activity 都能配 `startToCloseTimeout`（单步超时）、`retry`（重试策略）、`heartbeatTimeout`（心跳）。
- **Workflow ID 就是幂等键**：用同一个 ID 启动第二次会被拒绝。
- 适合「等人审批几天」这类超长流程，可以用 `sleep` 和 signal。
- 代价：要部署和运维 Temporal 集群（或用 Temporal Cloud），学习曲线也陡（workflow 代码必须是确定性的）。

### 9.4 Inngest / Trigger.dev（Serverless 友好）
- `step.run("读取 Git", () => ...)`：每一步自动持久化、自动重试，函数可以分多次调用执行完。
- 不用自己维护常驻 worker，适合 Vercel 这类 Serverless 部署。

### 9.5 Python：Celery
- `acks_late=True`：任务执行完才确认，worker 崩了任务会重新投递。
- 配合 broker 的 `visibility_timeout`，相当于心跳超时；任务本身要能安全地重复执行（幂等）。

### 9.6 取舍：怎么选
| 场景 | 选择 |
|---|---|
| 步骤简单、已经有 Redis、Node 技术栈 | **BullMQ** |
| 流程复杂、超长、要等人工审批、对可靠性要求高 | **Temporal** |
| Serverless 部署、不想运维基础设施 | **Inngest / Trigger.dev** |
| Python 技术栈 | **Celery**（复杂流程同样可以考虑 Temporal） |

今天手写的 demo 是为了理解原理。生产环境优先选框架，再按 9.1 的清单逐条检查框架**没帮你做**的部分。

## 10. 运行 Demo
需要 Node 18+，**零依赖**（只用 `node:http`），通过 `tsx` 运行 TypeScript：
```bash
npx tsx server.ts                 # 打开 http://localhost:3000
./test.sh                         # 另开终端：curl 验证幂等 / SSE / 轮询
```
可调环境变量：
| 变量 | 默认 | 作用 |
|---|---|---|
| `FAIL_RATE` | 0.3 | 每步随机失败概率（观察只重试当前步 + 指数退避） |
| `HANG_RATE` | 0 | 每步「卡死」概率（不再心跳，观察 sweeper 判死） |
| `STEP_MS` | 1500 | 每步耗时 |
| `STALE_MS` | 5000 | 心跳超时阈值 |

建议实验：
- `HANG_RATE=0.5 FAIL_RATE=0 npx tsx server.ts`：等任务被 sweeper 标 failed，再 `curl -XPOST localhost:3000/tasks/<id>/retry`，日志会显示「跳过已完成步骤」。
- 页面勾选「禁用 SSE」，观察降级为 2 秒轮询；或运行中重启服务，看 SSE 断开后的降级。

接口：`POST /tasks`（必须带 `Idempotency-Key`）、`GET /tasks/:id`（轮询）、`GET /tasks/:id/events`（SSE）、`POST /tasks/:id/retry`（从 checkpoint 续跑）。

**已验证**（2026-10-13）：同 key 两次 POST 返回同一任务（`deduplicated: true`）；缺 key 返回 400；SSE 推送逐步进度至 succeeded；随机失败后仅重试当前步；4 个卡死任务均在心跳超时后被 sweeper 标为 failed；retry 跳过已完成的 2 步续跑。
