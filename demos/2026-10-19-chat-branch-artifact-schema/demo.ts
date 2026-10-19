import assert from "node:assert/strict";
import { ChatStore } from "./chat.ts";

const s = await ChatStore.open();
const show = (label: string, convId: number) => {
  console.log(`\n— ${label}`);
  for (const m of s.loadActivePath(convId)) {
    const nav = m.total > 1 ? ` <${m.idx}/${m.total}>` : "";
    const st = m.status === "done" ? "" : ` [${m.status}]`;
    console.log(`  #${m.id} ${m.role.padEnd(9)}${nav}${st} ${JSON.stringify(m.content)}`);
  }
};
const ids = (convId: number) => s.loadActivePath(convId).map(m => m.id);

// 1) 正常一轮：user → assistant 流式 → done，生成 artifact v1
const { convId, rootId } = s.createConversation("计数器 Demo");
const u1 = s.addMessage(convId, rootId, "user", "做一个计数器");
const a1 = s.addMessage(convId, u1, "assistant", "", "streaming");
s.flush(a1, "好的，这是一个");
assert.ok(s.finish(a1, "好的，这是一个计数器组件。"));
const { artifactId, versionId: v1 } = s.createArtifact(convId, "Counter", { "App.tsx": "<button>+1</button>" }, a1);

// 2) 用户手改代码 → v2(user)；AI 基于"当前版本"改 → v3(ai)
const v2 = s.saveVersion(artifactId, v1, { "App.tsx": "<button className='big'>+1</button>" }, "user");
const u2 = s.addMessage(convId, a1, "user", "把按钮改成绿色");
const base = s.currentVersion(artifactId);
assert.equal(base.id, v2, "AI 必须读到用户手改的 v2");
const a2 = s.addMessage(convId, u2, "assistant", "已改成绿色。");
const v3 = s.saveVersion(artifactId, base.id, { "App.tsx": base.files["App.tsx"].replace("'big'", "'big green'") }, "ai", a2);
assert.match(s.currentVersion(artifactId).files["App.tsx"], /big green/, "用户的手改没有丢");
show("初始路径", convId);

// 3) 编辑 u2 → 兄弟分支；新回复流到一半用户点停止
const u2b = s.editUserMessage(u2, "把按钮改成红色");
assert.deepEqual(s.siblings(u2), [u2, u2b]);
const a2b = s.addMessage(convId, u2b, "assistant", "", "streaming");
s.flush(a2b, "好的，改成红");
assert.ok(s.stop(a2b));
assert.equal(s.flush(a2b, "好的，改成红色……"), false, "停止后迟到的 flush 被 CAS 拒绝");
let path = s.loadActivePath(convId);
assert.equal(path.at(-1)!.status, "interrupted");
assert.equal(path.at(-1)!.content, "好的，改成红", "半截内容保留");
show("编辑 u2 后（新回复被用户停止）", convId);

// 4) 重新生成被停止的那条 → 又一个兄弟
const a2c = s.regenerate(a2b);
assert.ok(s.finish(a2c, "已改成红色。"));
assert.deepEqual(s.siblings(a2b), [a2b, a2c]);
show("重新生成后", convId);

// 5) 切回 u2 <1/2>：沿 selected_child_id 走到原来的叶子 a2；再切到 u2b，记得上次看的是 a2c
assert.equal(s.switchBranch(convId, u2), a2);
assert.deepEqual(ids(convId), [u1, a1, u2, a2]);
show("切到 u2 <1/2>", convId);
assert.equal(s.switchBranch(convId, u2b), a2c, "回到分支 2 时停在上次看的 a2c，而不是第一个孩子");
show("切回 u2b <2/2>", convId);

// 6) 服务挂了：流到一半，之后再也没有心跳
const u3 = s.addMessage(convId, a2c, "user", "再加一个重置按钮");
const a3 = s.addMessage(convId, u3, "assistant", "", "streaming");
s.flush(a3, "可以，在计数器旁边");
s.now += 60; // 进程崩了，60 秒没心跳
const before = s.siblings(a3).length;
assert.deepEqual(s.sweepStale(30), [a3]);
assert.equal(s.siblings(a3).length, before, "清扫器不自动重跑：没有多出一条回复");
assert.equal(s.flush(a3, "可以，在计数器旁边加了"), false, "僵尸 worker 复活后写不进去");
path = s.loadActivePath(convId);
assert.equal(path.at(-1)!.status, "interrupted");
assert.equal(path.at(-1)!.content, "可以，在计数器旁边");
show("服务崩溃 + 清扫器之后（刷新页面看到的）", convId);

// 7) artifact 工作区指针不跟聊天分支走
s.switchBranch(convId, u2);
assert.equal(s.currentVersion(artifactId).id, v3, "切聊天分支不会改 artifact 当前版本");

// 8) 两个人同时基于 v3 保存 → 第二个冲突
s.saveVersion(artifactId, v3, { "App.tsx": "A" }, "user");
assert.throws(() => s.saveVersion(artifactId, v3, { "App.tsx": "B" }, "ai"), /版本冲突/);
assert.equal(s.history(artifactId).length, 4, "冲突那次整笔回滚，没留下孤儿版本");
console.log("\n— artifact 版本历史");
for (const v of s.history(artifactId)) console.log(`  v${v.version_no} ${v.source}${v.message_id ? ` (消息 #${v.message_id})` : ""}`);

console.log("\nALL PASS ✅");
