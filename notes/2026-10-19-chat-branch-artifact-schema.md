# 聊天分支、流式中断与 Artifact 版本：Artifacts 式对话产品怎么建表

> 10-17 留下的数据建模题，10-19 晚上补上。消息树 + 两个指针 + 三种状态 + 版本快照，附一个用真 SQLite 跑的 demo。

## 1. 场景

你在做一个 Artifacts 风格的 AI 对话产品，数据存在 Postgres 里，要支持三件事：

1. 用户可以**编辑**自己的某条历史消息，或者让 AI **重新生成**某条回复。这时会像 ChatGPT 那样产生分支，还能用 `< 2/3 >` 来回切换；
2. AI 生成的 artifact（比如一段 React 代码）有**版本**。用户也能手动改代码，改完之后 AI 要基于**最新的版本**接着改；
3. AI 的流式回复写到一半，可能会**被中断**：用户点了停止、网络断了，或者服务挂了。

## 2. Dong 的第一反应：数组，分叉处变二维

> Dong："每一个对话可以是一套数组列表，然后在分叉处变成二维数组维护每个分支。"

直觉是对的：对话本质上就是"一条主线，在某些地方分叉"。但用嵌套数组存，会在三个地方翻车：

- **分叉里还会再分叉**：分支 2 里又编辑一条消息，二维变三维、四维，结构越来越深，读写代码都很难写；
- **改一条要重写整段**：整段对话作为一个 JSON 存，追加一条就得读出来改完再写回；流式写入时两个请求同时改，还会互相覆盖（丢更新）；
- **不好查**：想知道"这条有几个兄弟版本"、"artifact 的 v3 是哪条消息生成的"，都得把 JSON 拆开来找。

业界的做法是**树**：每条消息只记住自己的上一条是谁（`parent_id`）。ChatGPT 导出的数据就是这个结构（`mapping` 里每个节点有 `parent` 和 `children`）。

## 3. 表结构

```sql
conversations(id, title, current_leaf_id)          -- 当前看的那条路径的末端
messages(
  id, conversation_id,
  parent_id,          -- 上一条；只有隐藏的 root 为 NULL
  role,               -- root / user / assistant
  content,
  status,             -- streaming / done / interrupted
  selected_child_id,  -- 这个节点下面，上次选的是哪个孩子
  heartbeat_at,       -- 流式时每次 flush 刷新
  created_at
)
INDEX (parent_id, id)                              -- 查兄弟、查最新孩子
artifacts(id, conversation_id, title, current_version_id)   -- 工作区指针
artifact_versions(id, artifact_id, version_no, parent_version_id,
                  content JSONB, source ai|user, message_id, created_at,
                  UNIQUE(artifact_id, version_no))
```

几个细节：

- **隐藏的 root 节点**：建会话时先插一条 `role=root`。这样"编辑第一条用户消息"也只是 root 下多一个孩子，不用给"多个根"写特殊逻辑；
- **分叉怎么表示**：编辑或重新生成时，**新插一条**，`parent_id` 和原来那条相同，两条就成了兄弟。原消息一个字都不动；
- **`< 2/3 >` 的数字**：同一个 parent 下有 3 个孩子，按创建顺序排，当前是第 2 个。

## 4. 当前选中的分支存在哪？

> Dong："一种方法是直接展示默认的第一条；或者是每个节点都存一份前端的状态？"

| 方案 | 问题 |
|---|---|
| 默认显示第一个孩子 | 最简单，但用户在分支 2 聊到第 5 轮，切走再切回来跳回分支 1 开头，"我刚才看的去哪了" |
| 每个节点存状态，但只在前端 | 思路对，但换设备、清缓存就没了 |
| **每个节点存 `selected_child_id`，写进库** | ✅ 换设备也在原地；代价是每次切换多写一次库，很便宜 |

再加上会话上的 `current_leaf_id`，两个指针各管一件事：`selected_child_id` 记"每个岔口上次走哪边"，`current_leaf_id` 记"现在看的路径的末端"，加载时直接从它出发。

## 5. 切换分支：不加载整棵树

> Dong："切换到 2 或者 3 的时候怎么处理？先基于切换的位置计算 leaf id，然后再加载完整的树是吗？"

前半句对，后半句不用。流程是：**改选中 → 算出 leaf → 只加载这条路径**。

1. **记下这次切换**：把父节点的 `selected_child_id` 改成第 2 个孩子；
2. **往下走到叶子**：从这个孩子出发，沿每个节点的 `selected_child_id`（没选过就取最新的孩子）一直走到没有孩子的节点，写回 `current_leaf_id`；
3. **只加载当前路径**：从 `current_leaf_id` 沿 `parent_id` 递归到根，再倒序；
4. **兄弟计数**：只查路径上那些节点的兄弟，用窗口函数顺手算出 `<idx/total>`。

```sql
WITH RECURSIVE path(id, parent_id, depth) AS (
  SELECT id, parent_id, 0 FROM messages
   WHERE id = (SELECT current_leaf_id FROM conversations WHERE id = $1)
  UNION ALL
  SELECT m.id, m.parent_id, p.depth + 1
    FROM messages m JOIN path p ON m.id = p.parent_id
),
sib AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY id) AS idx,
         COUNT(*)     OVER (PARTITION BY parent_id)             AS total
    FROM messages WHERE parent_id IN (SELECT parent_id FROM path)
)
SELECT m.*, sib.idx, sib.total
  FROM path JOIN messages m USING (id) LEFT JOIN sib USING (id)
 WHERE m.role <> 'root'
 ORDER BY path.depth DESC;
```

一条会话通常几十到几百条消息，这一趟很快。整棵树只在做"分支总览图"这类功能时才需要。

### 取舍：往下走放在 SQL 还是应用层？

"往下走到叶子"可以写成第二个递归 CTE，也可以在应用层循环（demo 里就是循环，每步一次索引查询）。路径长度几百以内两者差别不大；更在意往返次数就写进 SQL 或存储过程。另一个选择是**不存 `selected_child_id`，每次切换都选最新孩子**，省一个字段，但丢了"回到原地"的体验。

## 6. 流式回复被中断

Dong 自己把场景拆成了三种，比一刀切强得多：

### 6.1 前端断网：后端继续跑，刷新后接上 ✅

一开流就插一条 `status=streaming` 的消息，内容边生成边写库；刷新后前端拿这条消息的 id 去订阅后续增量，已落库的部分直接展示。

> 要补的一点：后端继续跑会继续烧 token，而用户可能已经走了。要不要"前端多久没心跳就停"，是产品取舍，要写清楚。

### 6.2 用户点停止：停生成、给终止状态 ✅

后端用 `AbortController` 取消 LLM 请求，消息改成 `interrupted`，**半截内容留着**，让用户知道停在哪，再给一个"重新生成"按钮。

### 6.3 服务挂了：超时改状态 ✅，重启后自动重跑 ❌

Dong 的原话是"超时会更新状态，重启后重新触发那次响应"。前半句对，后半句会翻车：

- **同一条流接不上**：绝大多数 LLM 接口不支持"从第 137 个 token 接着吐"，重启后没法把同一次生成补完；
- **自动重跑 = 再烧一次钱**，还可能插出第二条回复；而"超时"不等于"失败"，LLM 那边可能早就生成完了（10-14 聊过的同一类问题）。

更稳的做法：清扫器发现 `streaming` 且心跳过期 → 改成 `interrupted`，保留已落库的半截，**让用户自己点重新生成**（新开一个兄弟分支，而不是续写旧的）。

| 能保住的 | 保不住的 | 用户能做的 |
|---|---|---|
| 已经落库的半截正文 | 同一次生成的后续 token | 看半截、复制走、点重新生成开新分支 |

也可以做"把半截塞进 prompt 让模型续写"，但效果不稳定，一般不当默认行为。

### 6.4 落地细节

- **多久刷一次库**：每个 token 都写太贵，从不写刷新就是空的。常见是每 200～500ms，或凑够几十个字写一次，顺便刷新 `heartbeat_at`；
- **写入带条件**：`UPDATE ... WHERE id=$1 AND status='streaming'`。已经被停止或被清扫的消息，迟到的 flush 和复活的僵尸 worker 都写不进去（返回 0 行就退出），和 10-13 心跳/清扫器的 CAS 是同一招；
- **状态三个就够**：`streaming / done / interrupted`。

## 7. Artifact 版本：快照还是 diff？

> Dong："主要考虑的是记录 diff 还是记录每次的快照吧；git 是把每个文件存成一份然后复用，但这只适合大量文件的场景；demo 通常只涉及几个文件，所以我感觉记录 action，然后用户保存或者重新生成后更新一个快照。"

判断大体对：**文件少、体积小，直接存整份快照最简单**。Git 那套内容寻址、blob 复用，是为海量文件和跨提交去重设计的，这里用不上。

### 快照 vs action 日志（取舍）

| | 每次有意义的变更都存快照 | 平时只记 action，偶尔打快照 |
|---|---|---|
| 读某一版 | 读一行 | 从最近快照重放 action |
| 坏一条 | 只影响那一版 | 中间一条丢了或错了，后面全坏 |
| 存储 | 多一些（小文件无所谓） | 省 |
| 适合 | Artifacts / playground（默认） | 协同编辑、超大文档 |

默认：**AI 生成完、用户点保存、用户手改后防抖保存，都存一份完整快照**。action 日志可选，用来回答"谁改的"，不用来重建内容。

### "最新版本"在哪

就在 `artifacts.current_version_id`，它是**工作区指针**：

- 用户手改 → 插入新 version → 移动指针；
- AI 下次改之前**先读指针**拿内容，而不是拿"AI 上次生成的那版"，这样用户的手改不会丢；
- 移动指针带条件：`UPDATE artifacts SET current_version_id=$new WHERE id=$1 AND current_version_id=$base`，0 行说明别人（另一个标签页、AI）已经先改了，整笔回滚、提示冲突（乐观锁）。

### 和聊天分支的关系

`current_version_id` **不要和 `current_leaf_id` 绑死**。用户在分支 A 生成了 v3，切到分支 B，AI 应该基于 v3（当前工作区）还是基于分支 B 当时的版本？这是产品决定，但数据上要分开表达：版本通过 `message_id` 记录"由哪条回复产生"，需要时可以做"切分支时同步预览"，默认不自动跳，否则用户的手改会"消失"。

## 8. 数据库怎么选

> Dong："上面的几种场景数据库应该如何选择？"

**默认一个 Postgres 就够了**，不必一上来拆库。

| 数据 | 选择 | 原因 |
|---|---|---|
| 消息树、两个指针 | Postgres | 外键、事务、`WITH RECURSIVE`，关系型主场 |
| 正在流的内容 | Postgres，量大时加 Redis | 单会话写入量不大；QPS 很高时先写 Redis，完成/中断再落库，刷新时先库后 Redis |
| artifact 快照 | Postgres `JSONB` | 几个小文件一个 JSON 足够 |
| 大文件（MB 级） | 对象存储（S3 / R2） | 库里只存路径 + hash |

不建议一上来用的：

- **Mongo，只因为"长得像文档"**：消息树照样要自己维护父子关系，还丢了事务和递归查询；
- **只存 IndexedDB**：换设备、多端同步就没了，最多当缓存；
- **每类数据一个库**：运维和一致性成本远大于收益。等真撑不住了再拆。

## 9. Bad Case 翻车点

- **整段对话存一个 JSON 列**：并发追加互相覆盖，流式写入每 300ms 重写整段；
- **编辑消息时原地改 content**：旧分支没了，`< 1/2 >` 无从谈起，已生成的回复和改后的问题对不上；
- **切分支时加载整棵树再在前端算**：长会话、分支多时又慢又费流量；
- **`selected_child_id` 只放前端**：换设备回到第一个分支开头；
- **服务重启后自动重跑所有 `streaming` 消息**：双倍 token、重复回复，甚至重复触发工具调用的副作用；
- **流式 UPDATE 不带 `status='streaming'` 条件**：用户点了停止，迟到的 flush 又把状态写回去；
- **AI 基于"自己上次生成的版本"改代码**：用户刚手改的几行被覆盖；
- **artifact 指针跟着聊天分支自动跳**：用户以为手改丢了。

## 10. Review 审 AI 方案时问什么

1. 编辑/重新生成是插新行，还是改旧行？
2. 打开会话加载的是"当前路径"还是整棵树？路径从哪个指针出发？
3. 分支选择状态存在哪里，换设备还在吗？
4. 流式内容多久落一次库？中断后用户刷新看到什么？
5. 服务挂了谁把 `streaming` 改掉？会不会自动重跑？僵尸 worker 还能写吗？
6. AI 改 artifact 前读的是哪个版本？两个地方同时保存怎么办？

## 11. Demo 说明

`demos/2026-10-19-chat-branch-artifact-schema/`：用 sql.js（WASM 版真 SQLite，免编译）跑 `schema.sql`，写法贴近 Postgres。`bash test.sh` 会跑完 8 步并断言：

1. 一轮正常对话 + artifact v1；
2. 用户手改 → v2(user)，AI 读当前版本 → v3(ai)，手改没丢；
3. 编辑 u2 → 兄弟分支，新回复流到一半被停止，半截保留，迟到的 flush 被拒；
4. 重新生成 → 又一个兄弟；
5. 切回 `<1/2>` 走到原叶子，再切回 `<2/2>` 停在上次看的那条；
6. 服务崩溃：60 秒没心跳，清扫器改成 `interrupted`，**不多出回复**，僵尸 worker 写不进去；
7. 切聊天分支不影响 artifact 当前版本；
8. 两个人同时基于 v3 保存，第二个冲突并整笔回滚。

```text
— 切到 u2 <1/2>
  #4 user      <1/2> "把按钮改成绿色"
  #5 assistant "已改成绿色。"
— 服务崩溃 + 清扫器之后（刷新页面看到的）
  #9 user      "再加一个重置按钮"
  #10 assistant [interrupted] "可以，在计数器旁边"
ALL PASS ✅
```

## 12. 复习题

**1. 为什么不用"数组 + 分叉处变二维数组"存对话？**

<details><summary>参考答案</summary>

- 分叉里还会再分叉，维度会无限加深；
- 整段 JSON 存一列，追加一条要整段重写，并发写会丢更新；
- 查"有几个兄弟"、"某版本由哪条消息生成"都要拆 JSON；
- 树（`parent_id`）每条消息一行，插入是 O(1)，按需查路径和兄弟。

</details>

**2. 用户编辑了第 3 条消息，库里发生了什么？**

<details><summary>参考答案</summary>

- **插入**一条新的 user 消息，`parent_id` 和原第 3 条相同，成为兄弟；原消息不动；
- 父节点 `selected_child_id` 指向新消息，会话 `current_leaf_id` 指向新消息；
- 随后 AI 的回复挂在新消息下面。

</details>

**3. `selected_child_id` 和 `current_leaf_id` 各管什么？只留一个行不行？**

<details><summary>参考答案</summary>

- `selected_child_id`：每个岔口"上次走哪边"，让切回某分支时能回到原来的深处；
- `current_leaf_id`：当前路径的末端，加载时直接从它沿 `parent_id` 往上走；
- 只留 `current_leaf_id`：切到某个兄弟时不知道往下该走哪条，只能取默认（最新/第一个）孩子；
- 只留 `selected_child_id`：每次加载都要从 root 往下走一遍，也能用，但多一趟。两个都存最省事。

</details>

**4. 用户点了 `< 2/3 >`，后端依次做哪几步？要不要加载整棵树？**

<details><summary>参考答案</summary>

1. 把父节点的 `selected_child_id` 改成第 2 个孩子；
2. 从它沿 `selected_child_id`（没选过取最新孩子）走到叶子，写回 `current_leaf_id`；
3. 从叶子 `WITH RECURSIVE` 沿 `parent_id` 到根，倒序返回；
4. 用窗口函数只算路径上节点的兄弟数。

不需要整棵树，整棵树只给"分支总览"用。

</details>

**5. 流式回复中三种中断（断网 / 点停止 / 服务挂了），库里的状态和用户刷新后看到的分别是什么？**

<details><summary>参考答案</summary>

- **断网**：后端继续，消息仍是 `streaming`，内容持续落库；刷新后先显示已落库部分，再订阅后续增量，最后变 `done`。注意 token 成本，可以设"前端多久没心跳就停"；
- **点停止**：取消 LLM 请求，改 `interrupted`，半截保留，给"重新生成"；
- **服务挂了**：清扫器发现心跳过期，改 `interrupted`，半截保留；**不自动重跑**，由用户点重新生成开新兄弟。

</details>

**6. 服务重启后为什么不该自动重新触发那次生成？**

<details><summary>参考答案</summary>

- 同一条 LLM 流接不上，重跑是从头再生成一次，要再付一次钱；
- 超时 ≠ 失败，原来那次可能已经完成，重跑会多出一条回复；
- 如果回复里有工具调用，重跑可能重复触发副作用；
- 正确做法：标 `interrupted` + 保留半截 + 交给用户决定。

</details>

**7. 流式 flush 的 SQL 为什么要带 `AND status = 'streaming'`？**

<details><summary>参考答案</summary>

- 这是条件写（CAS）：消息已经被用户停止或被清扫器改成 `interrupted` 后，迟到的 flush、复活的僵尸 worker 都会返回 0 行，不会把内容或状态写回去；
- worker 看到 0 行就该自行退出，和 10-13 心跳/清扫器的套路一样。

</details>

**8. 内容多久落一次库？太频繁、太稀疏各有什么问题？**

<details><summary>参考答案</summary>

- 常见每 200～500ms 或每凑够几十个字一次，同时刷新 `heartbeat_at`；
- 太频繁：每 token 一次 UPDATE，写放大，连接池压力大；
- 太稀疏：刷新页面看到的内容落后很多，崩溃时丢得多，心跳也不准；
- 写入量真的大时，热数据先放 Redis，完成/中断时一次落库。

</details>

**9. Artifact 为什么默认存快照而不是 diff / action 日志？什么时候反过来？**

<details><summary>参考答案</summary>

- 文件少、体积小，快照成本低；读任一版只读一行；某一版坏了不影响别的版本；
- 只记 action 要重放，中间一条丢失或出错整条链都坏；
- 反过来的场景：协同实时编辑（OT/CRDT）、超大文档、大量文件跨版本去重（Git 式内容寻址）。

</details>

**10. 用户手改了代码，接着让 AI "把按钮改成绿色"，AI 怎么保证基于用户改过的那版？两个标签页同时保存怎么办？**

<details><summary>参考答案</summary>

- 手改存成新 version 并移动 `artifacts.current_version_id`；AI 改之前读这个指针，而不是读"AI 上次生成的版本"；
- 移动指针带条件 `WHERE current_version_id = $base`，0 行就是冲突：回滚，提示基于最新版本重试（乐观锁）。

</details>

**11. 切换聊天分支时，artifact 预览要不要跟着跳到那个分支生成的版本？**

<details><summary>参考答案</summary>

- 数据上分开：`current_version_id` 是工作区，`current_leaf_id` 是聊天视图，别绑死；
- 默认不自动跳，否则用户的手改看起来像"丢了"；
- 产品上可以提供"切换到此分支对应的版本"按钮，靠 `artifact_versions.message_id` 找到对应版本。

</details>

**12. 这几类数据该用什么库？为什么不一上来用 Mongo？**

<details><summary>参考答案</summary>

- 消息树、指针、artifact 元数据和小快照：一个 Postgres（外键、事务、递归查询、JSONB）；
- 流式热数据：量大时加 Redis；大文件内容：对象存储，库里存路径 + hash；
- Mongo 只因"像文档"：父子关系照样自己维护，还丢了事务和递归查询；拆多个库的一致性和运维成本远超收益。

</details>

**13. 追问：为什么要有一个隐藏的 root 节点？**

<details><summary>参考答案</summary>

- 编辑第一条用户消息时，新旧两条都需要一个共同的 parent 才能成为兄弟；
- 有了 root，"第一条"和"其他条"走同一套逻辑，`< 1/2 >` 也能显示在第一条上；
- 不用 root 就得让 `parent_id IS NULL` 的多条消息当兄弟，并把"根上选了哪个"存到会话上，特殊分支变多。

</details>
