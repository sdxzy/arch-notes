# Demo：聊天分支 + 流式中断 + Artifact 版本的表结构

用真 SQLite（sql.js，WASM，免编译）跑 `schema.sql`，DDL 写法贴近 Postgres。

- `schema.sql` — 四张表：conversations / messages（parent_id 树 + selected_child_id + status）/ artifacts / artifact_versions
- `chat.ts` — 算法：加消息、编辑/重新生成成兄弟、切分支往下走到叶子、`WITH RECURSIVE` 加载当前路径并算 `< 2/3 >` 的数字、流式 flush/stop/清扫器（CAS）、artifact 快照 + 乐观锁
- `demo.ts` — 8 步场景 + 断言

```bash
bash test.sh   # 或 npm test；首次会 npm install sql.js tsx
```
