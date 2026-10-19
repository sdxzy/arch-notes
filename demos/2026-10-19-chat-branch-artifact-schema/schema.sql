-- Artifacts 风格聊天：消息树 + 分支指针 + 流式状态 + artifact 版本快照
-- 这份 DDL 用 SQLite 跑 demo，写法刻意贴近 Postgres；
-- 迁到 Postgres 时：INTEGER PRIMARY KEY → BIGSERIAL / identity，content_json TEXT → JSONB，
-- *_at INTEGER → timestamptz，其余基本照搬。

CREATE TABLE conversations (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  current_leaf_id INTEGER REFERENCES messages(id),  -- 当前看的那条路径的末端
  created_at      INTEGER NOT NULL
);

CREATE TABLE messages (
  id                INTEGER PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id),
  parent_id         INTEGER REFERENCES messages(id),   -- 上一条；只有隐藏的 root 为 NULL
  role              TEXT NOT NULL CHECK (role IN ('root','user','assistant')),
  content           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'done'
                    CHECK (status IN ('streaming','done','interrupted')),
  selected_child_id INTEGER REFERENCES messages(id),   -- 这个节点下次往下走哪个孩子
  heartbeat_at      INTEGER,                           -- 流式时每次 flush 刷新，清扫器用
  created_at        INTEGER NOT NULL
);
-- 查兄弟（< 2/3 >）和"最新孩子"
CREATE INDEX idx_messages_parent ON messages(parent_id, id);
-- 清扫器只扫正在流的消息（Postgres 可写成部分索引 WHERE status = 'streaming'）
CREATE INDEX idx_messages_streaming ON messages(status, heartbeat_at);

CREATE TABLE artifacts (
  id                 INTEGER PRIMARY KEY,
  conversation_id    INTEGER NOT NULL REFERENCES conversations(id),
  title              TEXT NOT NULL,
  current_version_id INTEGER REFERENCES artifact_versions(id)  -- 工作区指针，不绑聊天分支
);

CREATE TABLE artifact_versions (
  id                INTEGER PRIMARY KEY,
  artifact_id       INTEGER NOT NULL REFERENCES artifacts(id),
  version_no        INTEGER NOT NULL,
  parent_version_id INTEGER REFERENCES artifact_versions(id),  -- 基于哪一版改的
  content_json      TEXT NOT NULL,                             -- 整份快照 {"App.tsx": "..."}
  source            TEXT NOT NULL CHECK (source IN ('ai','user')),
  message_id        INTEGER REFERENCES messages(id),           -- 哪条 AI 回复产生的；手改为 NULL
  created_at        INTEGER NOT NULL,
  UNIQUE (artifact_id, version_no)
);
