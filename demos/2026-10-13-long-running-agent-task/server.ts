// 最小 Demo：长程 Agent 任务（幂等 / 分步 checkpoint / 心跳 + 清扫 / SSE + 轮询兜底）
// 运行：npx tsx server.ts   然后打开 http://localhost:3000
import http from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type Status = "queued" | "running" | "succeeded" | "failed";
interface Task {
  id: string; status: Status; step: number; totalSteps: number; stepName: string;
  checkpoints: Record<string, string>;   // 每步结果持久化（真实系统放 DB）
  attempts: Record<string, number>; heartbeatAt: number; error?: string; result?: string; updatedAt: number;
}

const PORT = Number(process.env.PORT ?? 3000);
const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0.3);       // 每步随机失败概率
const HANG_RATE = Number(process.env.HANG_RATE ?? 0);         // 模拟"进程卡死"（不再发心跳、不回调）
const STEP_MS = Number(process.env.STEP_MS ?? 1500);
const STALE_MS = Number(process.env.STALE_MS ?? 5000);        // 心跳超过此时间视为僵死
const MAX_RETRY = 3;
const STEPS = ["读取 Git 提交", "读取日历", "生成周报"];

const tasks = new Map<string, Task>();
const idem = new Map<string, string>();                       // Idempotency-Key -> taskId（真实系统：DB 唯一索引 + TTL）
const subs = new Map<string, Set<http.ServerResponse>>();     // SSE 订阅者

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const view = (t: Task) => ({ id: t.id, status: t.status, step: t.step, totalSteps: t.totalSteps, stepName: t.stepName,
  progress: Math.round((t.step / t.totalSteps) * 100), attempts: t.attempts, error: t.error, result: t.result });

function update(t: Task, patch: Partial<Task>) {
  Object.assign(t, patch, { updatedAt: Date.now() });
  const data = `id: ${t.updatedAt}\nevent: progress\ndata: ${JSON.stringify(view(t))}\n\n`;
  for (const res of subs.get(t.id) ?? []) res.write(data);
  if (t.status === "succeeded" || t.status === "failed") for (const res of subs.get(t.id) ?? []) res.end();
}

// 模拟 Agent：逐步执行，已有 checkpoint 的步骤直接跳过，失败只重试当前步
async function runAgent(t: Task) {
  update(t, { status: "running" });
  for (let i = 0; i < STEPS.length; i++) {
    const name = STEPS[i];
    if (t.checkpoints[name]) { console.log(`[${t.id.slice(0, 8)}] 跳过已完成步骤：${name}`); continue; }
    while (true) {
      if (t.status === "failed") return;                       // 已被清扫器判死，停止
      t.attempts[name] = (t.attempts[name] ?? 0) + 1;
      update(t, { stepName: `${name}（第 ${t.attempts[name]} 次）`, heartbeatAt: Date.now() });
      try {
        await work(t, name);
        t.checkpoints[name] = `${name} 的结果@${new Date().toISOString()}`;
        update(t, { step: i + 1, heartbeatAt: Date.now() });
        break;
      } catch (e) {
        console.log(`[${t.id.slice(0, 8)}] ${name} 失败：${(e as Error).message}`);
        if (t.attempts[name] >= MAX_RETRY) return update(t, { status: "failed", error: `${name} 重试 ${MAX_RETRY} 次仍失败` });
        await sleep(300 * 2 ** t.attempts[name]);               // 指数退避
      }
    }
  }
  update(t, { status: "succeeded", stepName: "完成", result: `# 本周周报\n基于：${Object.keys(t.checkpoints).join("、")}` });
}

async function work(t: Task, name: string) {
  if (Math.random() < HANG_RATE) { console.log(`[${t.id.slice(0, 8)}] ${name} 卡死（模拟）`); await new Promise(() => {}); }
  for (let ms = 0; ms < STEP_MS; ms += 500) { await sleep(500); t.heartbeatAt = Date.now(); } // 执行中持续心跳
  if (Math.random() < FAIL_RATE) throw new Error("上游接口超时（模拟）");
}

// 清扫器：不依赖"完成回调"，定期把心跳过期的 running 任务标为 failed
setInterval(() => {
  for (const t of tasks.values())
    if (t.status === "running" && Date.now() - t.heartbeatAt > STALE_MS) {
      console.log(`[sweeper] ${t.id.slice(0, 8)} 心跳超时，标记 failed`);
      update(t, { status: "failed", error: `心跳超时 ${STALE_MS}ms，判定僵死（可调用 /retry 从 checkpoint 续跑）` });
    }
}, 1000);

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const m = url.pathname.match(/^\/tasks\/([^/]+)(\/events|\/retry)?$/);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(new URL("./index.html", import.meta.url)));
  }
  if (req.method === "POST" && url.pathname === "/tasks") {
    const key = req.headers["idempotency-key"] as string | undefined;
    if (!key) return json(res, 400, { error: "缺少 Idempotency-Key 请求头" });
    const existing = idem.get(key);
    if (existing) return json(res, 200, { ...view(tasks.get(existing)!), deduplicated: true });
    const t: Task = { id: randomUUID(), status: "queued", step: 0, totalSteps: STEPS.length, stepName: "排队中",
      checkpoints: {}, attempts: {}, heartbeatAt: Date.now(), updatedAt: Date.now() };
    tasks.set(t.id, t); idem.set(key, t.id);
    void runAgent(t);                                          // 不阻塞请求：立刻返回 202
    return json(res, 202, view(t));
  }
  const t = m && tasks.get(m[1]);
  if (m && !t) return json(res, 404, { error: "task not found" });
  if (t && req.method === "GET" && !m![2]) return json(res, 200, view(t));     // 轮询 / 重连后状态对齐
  if (t && req.method === "POST" && m![2] === "/retry") {
    if (t.status !== "failed") return json(res, 409, { error: "只有 failed 任务能重试" });
    t.attempts = {}; update(t, { error: undefined, heartbeatAt: Date.now() }); void runAgent(t);
    return json(res, 202, view(t));
  }
  if (t && req.method === "GET" && m![2] === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: progress\ndata: ${JSON.stringify(view(t))}\n\n`); // 连上先推一次当前快照
    if (t.status === "succeeded" || t.status === "failed") return res.end();
    if (!subs.has(t.id)) subs.set(t.id, new Set());
    subs.get(t.id)!.add(res);
    const ping = setInterval(() => res.write(`: ping\n\n`), 15000); // 防代理掐空闲连接
    req.on("close", () => { clearInterval(ping); subs.get(t.id)?.delete(res); });
    return;
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`http://localhost:${PORT}  FAIL_RATE=${FAIL_RATE} HANG_RATE=${HANG_RATE}`));
