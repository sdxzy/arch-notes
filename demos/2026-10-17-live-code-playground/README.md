# Live Code Playground demo

零构建静态页面：左边 CodeMirror 6 编辑 JSX/TSX，右边 sandboxed iframe 实时渲染。

- 在线打开：https://sdxzy.github.io/arch-notes/demos/2026-10-17-live-code-playground/
- 本地：在仓库根目录 `python3 -m http.server`，打开 `/demos/2026-10-17-live-code-playground/`（直接双击 file:// 打开也能跑，但 CDN 需要联网）

流水线：防抖 300ms → sucrase 在浏览器里编译 → postMessage 给 `sandbox="allow-scripts"` 的 srcdoc iframe → iframe 用 import map 把 react 指向 esm.sh，Blob URL + 动态 import 执行模块 → createRoot 渲染 default export → 回执 `rendered`。

验证（headless Chromium）：

```bash
npm i playwright-core
CHROME=/usr/bin/google-chrome node test.mjs <url> playground.png
```
