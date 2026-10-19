// 数据访问层：所有算法都写成 SQL + 很薄的 TS，换成 Postgres 只需替换 db 驱动
import initSqlJs, { type Database } from "sql.js";
import { readFileSync } from "node:fs";

export type Row = Record<string, any>;
export type Status = "streaming" | "done" | "interrupted";

export class ChatStore {
  now = 1_000; // 注入时钟，方便模拟"过了 30 秒"
  private constructor(private db: Database) {}

  static async open() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("PRAGMA foreign_keys = ON");
    db.run(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    return new ChatStore(db);
  }

  // ---------- 小工具 ----------
  all(sql: string, p: any[] = []): Row[] {
    const st = this.db.prepare(sql); st.bind(p);
    const rows: Row[] = []; while (st.step()) rows.push(st.getAsObject()); st.free();
    return rows;
  }
  get(sql: string, p: any[] = []): Row | undefined { return this.all(sql, p)[0]; }
  run(sql: string, p: any[] = []): number { this.db.run(sql, p); return this.db.getRowsModified(); }
  private lastId(): number { return this.get("SELECT last_insert_rowid() AS id")!.id; }
  tx<T>(fn: () => T): T {
    this.db.run("BEGIN");
    try { const r = fn(); this.db.run("COMMIT"); return r; }
    catch (e) { this.db.run("ROLLBACK"); throw e; }
  }
  private tick() { return ++this.now; }

  // ---------- 会话 & 消息树 ----------
  /** 建会话时同时建一个隐藏 root，这样"编辑第一条消息"也只是 root 下多一个孩子 */
  createConversation(title: string): { convId: number; rootId: number } {
    return this.tx(() => {
      this.run("INSERT INTO conversations(title, created_at) VALUES (?, ?)", [title, this.tick()]);
      const convId = this.lastId();
      this.run("INSERT INTO messages(conversation_id, parent_id, role, created_at) VALUES (?, NULL, 'root', ?)", [convId, this.tick()]);
      const rootId = this.lastId();
      this.run("UPDATE conversations SET current_leaf_id = ? WHERE id = ?", [rootId, convId]);
      return { convId, rootId };
    });
  }

  /** 挂一个新孩子：父节点的 selected_child_id 指向它，会话的 current_leaf_id 也指向它 */
  addMessage(convId: number, parentId: number, role: "user" | "assistant", content: string, status: Status = "done"): number {
    return this.tx(() => {
      const t = this.tick();
      this.run(
        `INSERT INTO messages(conversation_id, parent_id, role, content, status, heartbeat_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [convId, parentId, role, content, status, status === "streaming" ? t : null, t]);
      const id = this.lastId();
      this.run("UPDATE messages SET selected_child_id = ? WHERE id = ?", [id, parentId]);
      this.run("UPDATE conversations SET current_leaf_id = ? WHERE id = ?", [id, convId]);
      return id;
    });
  }

  /** 编辑用户消息 = 在同一个 parent 下插一个兄弟，原消息一字不动 */
  editUserMessage(msgId: number, newContent: string): number {
    const m = this.get("SELECT conversation_id, parent_id, role FROM messages WHERE id = ?", [msgId])!;
    if (m.role !== "user") throw new Error("只能编辑用户消息");
    return this.addMessage(m.conversation_id, m.parent_id, "user", newContent);
  }

  /** 重新生成 = 在同一个 parent 下开一条新的 streaming 兄弟 */
  regenerate(assistantMsgId: number): number {
    const m = this.get("SELECT conversation_id, parent_id, role FROM messages WHERE id = ?", [assistantMsgId])!;
    if (m.role !== "assistant") throw new Error("只能重新生成 AI 回复");
    return this.addMessage(m.conversation_id, m.parent_id, "assistant", "", "streaming");
  }

  /** 切 < 2/3 >：改父节点的选择 → 沿 selected_child_id 往下走到叶子 → 写回 current_leaf_id */
  switchBranch(convId: number, childId: number): number {
    return this.tx(() => {
      const c = this.get("SELECT parent_id FROM messages WHERE id = ? AND conversation_id = ?", [childId, convId]);
      if (!c) throw new Error("消息不属于该会话");
      this.run("UPDATE messages SET selected_child_id = ? WHERE id = ?", [childId, c.parent_id]);
      const leaf = this.walkDown(childId);
      this.run("UPDATE conversations SET current_leaf_id = ? WHERE id = ?", [leaf, convId]);
      return leaf;
    });
  }

  /** 往下走：优先 selected_child_id，没选过就取最新的孩子；没有孩子就是叶子 */
  walkDown(fromId: number): number {
    let id = fromId;
    for (let guard = 0; guard < 10_000; guard++) {
      const next = this.get(
        `SELECT COALESCE(m.selected_child_id,
                 (SELECT MAX(c.id) FROM messages c WHERE c.parent_id = m.id)) AS nxt
         FROM messages m WHERE m.id = ?`, [id])!.nxt;
      if (next == null) return id;
      id = next;
    }
    throw new Error("树里有环？");
  }

  /** 只加载当前路径：从叶子沿 parent_id 递归到根，顺带用窗口函数算出 < idx/total > */
  loadActivePath(convId: number): Row[] {
    return this.all(
      `WITH RECURSIVE path(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM messages
          WHERE id = (SELECT current_leaf_id FROM conversations WHERE id = ?)
         UNION ALL
         SELECT m.id, m.parent_id, p.depth + 1
           FROM messages m JOIN path p ON m.id = p.parent_id
       ),
       sib AS (
         SELECT s.id,
                ROW_NUMBER() OVER (PARTITION BY s.parent_id ORDER BY s.id) AS idx,
                COUNT(*)     OVER (PARTITION BY s.parent_id)               AS total
           FROM messages s
          WHERE s.parent_id IN (SELECT parent_id FROM path)  -- 只看路径上节点的兄弟，不扫整棵树
       )
       SELECT m.id, m.role, m.content, m.status, sib.idx, sib.total
         FROM path JOIN messages m ON m.id = path.id
         LEFT JOIN sib ON sib.id = m.id
        WHERE m.role <> 'root'
        ORDER BY path.depth DESC`, [convId]);
  }

  siblings(msgId: number): number[] {
    return this.all(
      "SELECT id FROM messages WHERE parent_id = (SELECT parent_id FROM messages WHERE id = ?) ORDER BY id",
      [msgId]).map(r => r.id);
  }

  // ---------- 流式生成 ----------
  /** 每 200~500ms 或凑够几十个字调用一次；WHERE status='streaming' 是 CAS：已被中断的消息不再接受写入 */
  flush(msgId: number, contentSoFar: string): boolean {
    return this.run(
      "UPDATE messages SET content = ?, heartbeat_at = ? WHERE id = ? AND status = 'streaming'",
      [contentSoFar, this.tick(), msgId]) === 1;
  }
  finish(msgId: number, finalContent: string): boolean {
    return this.run(
      "UPDATE messages SET content = ?, status = 'done', heartbeat_at = NULL WHERE id = ? AND status = 'streaming'",
      [finalContent, msgId]) === 1;
  }
  /** 用户点停止：只改状态，半截内容保留 */
  stop(msgId: number): boolean {
    return this.run(
      "UPDATE messages SET status = 'interrupted', heartbeat_at = NULL WHERE id = ? AND status = 'streaming'",
      [msgId]) === 1;
  }
  /** 清扫器：心跳过期的 streaming → interrupted。不自动重跑 LLM（超时 ≠ 失败，重跑 = 再烧一次钱） */
  sweepStale(ttl: number): number[] {
    const stale = this.all(
      "SELECT id FROM messages WHERE status = 'streaming' AND heartbeat_at < ?", [this.now - ttl]).map(r => r.id);
    // 逐条 CAS，Postgres 里可以一条 UPDATE ... RETURNING id
    return stale.filter(id => this.run(
      "UPDATE messages SET status = 'interrupted', heartbeat_at = NULL WHERE id = ? AND status = 'streaming' AND heartbeat_at < ?",
      [id, this.now - ttl]) === 1);
  }

  // ---------- Artifact 版本 ----------
  createArtifact(convId: number, title: string, files: Record<string, string>, messageId: number) {
    return this.tx(() => {
      this.run("INSERT INTO artifacts(conversation_id, title) VALUES (?, ?)", [convId, title]);
      const artifactId = this.lastId();
      const v = this.insertVersion(artifactId, null, files, "ai", messageId);
      this.run("UPDATE artifacts SET current_version_id = ? WHERE id = ?", [v, artifactId]);
      return { artifactId, versionId: v };
    });
  }

  private insertVersion(artifactId: number, parentVersionId: number | null, files: Record<string, string>, source: "ai" | "user", messageId: number | null): number {
    const no = this.get("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM artifact_versions WHERE artifact_id = ?", [artifactId])!.n;
    this.run(
      `INSERT INTO artifact_versions(artifact_id, version_no, parent_version_id, content_json, source, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [artifactId, no, parentVersionId, JSON.stringify(files), source, messageId, this.tick()]);
    return this.lastId();
  }

  /**
   * 存一个新快照并移动工作区指针。baseVersionId = 调用方"以为"的当前版本；
   * 指针已经被别人挪走 → 冲突（乐观锁，和清扫器同一个 CAS 套路），整笔回滚。
   */
  saveVersion(artifactId: number, baseVersionId: number, files: Record<string, string>, source: "ai" | "user", messageId: number | null = null): number {
    return this.tx(() => {
      const v = this.insertVersion(artifactId, baseVersionId, files, source, messageId);
      const ok = this.run(
        "UPDATE artifacts SET current_version_id = ? WHERE id = ? AND current_version_id = ?",
        [v, artifactId, baseVersionId]);
      if (ok === 0) throw new Error(`版本冲突：当前版本已不是 v#${baseVersionId}，请基于最新版本重试`);
      return v;
    });
  }

  /** AI 下次改之前读这里：永远拿工作区指针指向的那份，而不是"AI 上次生成的那份" */
  currentVersion(artifactId: number) {
    const r = this.get(
      `SELECT v.id, v.version_no, v.source, v.message_id, v.content_json
         FROM artifacts a JOIN artifact_versions v ON v.id = a.current_version_id
        WHERE a.id = ?`, [artifactId])!;
    return { ...r, files: JSON.parse(r.content_json) as Record<string, string> };
  }

  history(artifactId: number): Row[] {
    return this.all("SELECT version_no, source, message_id FROM artifact_versions WHERE artifact_id = ? ORDER BY version_no", [artifactId]);
  }
}
