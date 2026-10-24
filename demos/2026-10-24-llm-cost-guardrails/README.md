# Demo：LLM 费用失控护栏

纯 TypeScript，离线运行：LLM、工具、时钟都是 mock，不需要联网和真实 key。

- `store.ts` — 状态存取接口 `StateStore`（`incr` / `incrIfBelow` / `setIfAbsent`）+ 内存实现。**内存 Map 仅为演示，生产用数据库（权威）+ Redis（加速）**，注释里写了对应 SQL / Redis 命令
- `errors.ts` — 拒绝语义：速率类 `429`+`Retry-After`、额度类 `402`+`reset_at`、断路器 `409`
- `budget.ts` — 用户/全局日预算：预占（最坏情况）+ 结算（退差额）
- `run-guard.ts` — 单 run 护栏：步数 / 花费 / token / 时长 / 重复动作 / 工具连续报错
- `scheduler.ts` — 并发上限 + 有界公平队列（全局/每用户长度上限、等待时间上限）
- `breaker.ts` — 断路器：连续失败 N 次暂停、成功清零、冷却后半开只放 1 个探测
- `demo.ts` — 六组场景 + 断言，最后打印 `ALL PASS`

```bash
bash test.sh   # 或 npm test；首次会 npm install tsx
```
