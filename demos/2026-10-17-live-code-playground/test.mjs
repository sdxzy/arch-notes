// 用 headless Chromium 验证 playground：
//   npm i playwright-core && node test.mjs [url] [screenshot.png]
// 默认 Chrome 路径可用 CHROME=/path/to/chrome 覆盖
import { chromium } from "playwright-core";

const url = process.argv[2] || "https://sdxzy.github.io/arch-notes/demos/2026-10-17-live-code-playground/";
const shot = process.argv[3] || "playground.png";
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) process.exitCode = 1; };
const pickAndWait = async (name) => {
  const b = await page.evaluate(() => window.__rendered || 0);
  await page.evaluate((n) => window.__playground.pick(n), name);
  await page.waitForFunction((b) => window.__rendered > b && window.__status === "ok", b, { timeout: 20000 });
};
const preview = () => page.frameLocator("iframe[title=preview]");

await page.goto(url);
await page.waitForFunction(() => window.__status === "ok", null, { timeout: 30000 });
ok(true, `首次渲染成功（编辑器：${await page.evaluate(() => window.__editor)}）`);
ok((await preview().locator("h1").textContent()).includes("Count: 0"), "预览显示 Count: 0");

// 1. 在编辑器里打字：把 "Count:" 改成 "Clicks:"
const editor = page.locator(".cm-content, #editor textarea").first();
await editor.click();
await page.keyboard.press("Control+End");
const before = await page.evaluate(() => window.__rendered);
await page.evaluate(() => window.__playground.setCode(window.__playground.getCode().replace("Count:", "Clicks:")));
await page.keyboard.type("\n// typed by playwright");
await page.waitForFunction((b) => window.__rendered > b && window.__status === "ok", before, { timeout: 15000 });
ok((await preview().locator("h1").textContent()).includes("Clicks: 0"), "改代码后预览更新为 Clicks: 0");
await preview().locator("button").click();
ok((await preview().locator("h1").textContent()).includes("Clicks: 1"), "iframe 内点击 +1 生效");

// 2. 编译错误：父页面显示
await page.evaluate(() => window.__playground.setCode("export default function App() { return <div> }"));
await page.waitForFunction(() => window.__status === "err", null, { timeout: 10000 });
ok((await page.locator("#err").textContent()).includes("编译错误"), "语法错误 → 父页面显示编译错误");

// 3. 运行时错误：ErrorBoundary 捕获并回传
await page.evaluate(() => window.__playground.pick("故意出错 Broken"));
await page.waitForFunction(() => document.querySelector("#err").textContent.includes("render"), null, { timeout: 15000 });
const errText = await page.locator("#err").textContent();
ok(await page.locator("#err").isVisible() && /undefined|name/.test(errText), `Broken 示例 → 错误面板：${errText.replace(/^.*?·[^\n]*?LLM 自修复/, "").split("\n")[0].slice(0, 90)}`);

// 4. 沙箱隔离
await pickAndWait("沙箱隔离检查 Security");
const sec = await preview().locator("table").textContent();
ok(!sec.includes("⚠️"), "document.cookie / localStorage / parent / top 全部被拦截");
console.log("      " + (await preview().locator("body").innerText()).replace(/\n+/g, " | "));

// 5. 死循环：看门狗重建 iframe，之后还能继续用
await page.evaluate(() => window.__playground.pick("死循环 Infinite loop"));
await page.waitForFunction(() => (window.__rebuilt || 0) >= 1, null, { timeout: 20000 });
ok(true, "死循环 → 超时后 iframe 被销毁重建");
await pickAndWait("计数器 Counter");
ok((await preview().locator("h1").textContent()).includes("Count: 0"), "重建后的沙箱可以继续渲染");

// 截图：列表示例
await pickAndWait("带 key 的列表 List");
ok((await preview().locator("li").count()) === 3, "列表示例渲染出 3 个 li");
await page.screenshot({ path: shot });
console.log("screenshot →", shot);
await browser.close();
