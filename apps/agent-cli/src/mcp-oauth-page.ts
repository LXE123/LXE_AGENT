import type { ServerResponse } from "node:http";
import logo from "./assets/lxe-agent-logo.data-url.txt";

const services = '<span class="service-name">「MCP 服务」</span>';
const messages = {
  received: {
    title: "已收到授权回调",
    detail: `你可以关闭此标签页，回到 LXE Agent 的${services}查看连接状态。`,
  },
  incomplete: {
    title: "授权未完成",
    detail: `请回到 LXE Agent 的${services}查看连接状态，重新发起授权。`,
  },
  invalid: {
    title: "授权回调无效",
    detail: `请回到 LXE Agent 的${services}重新发起授权。`,
  },
};

export function sendMcpCallbackPage(response: ServerResponse, state: keyof typeof messages) {
  const { title, detail } = messages[state];
  response.writeHead(state === "received" ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · LXE Agent</title>
  <link rel="icon" href="data:,">
  <style>
    :root {
      color-scheme: light dark;
      --cds-surface-nav: #fcfcfb;
      --cds-surface-panel: #ffffff;
      --cds-ink: #0b0b0b;
      --cds-secondary: #52514e;
      --cds-alpha-2: rgb(11 11 11 / 10%);
      --danger: #b42318;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --cds-surface-nav: #151515;
        --cds-surface-panel: #1a1a19;
        --cds-ink: #f5f4ed;
        --cds-secondary: #bfbdb5;
        --cds-alpha-2: rgb(255 255 255 / 10%);
        --danger: #f28e85;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 1.25rem;
      background: var(--cds-surface-nav);
      color: var(--cds-ink);
      font-family: "HarmonyOS Sans SC", -apple-system, BlinkMacSystemFont, "SF Pro Text",
        "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei UI", sans-serif;
    }
    main {
      width: min(100%, 28rem);
      padding: clamp(1.5rem, 6vw, 2.25rem);
      background: var(--cds-surface-panel);
      border: 1px solid var(--cds-alpha-2);
      border-radius: 1rem;
    }
    .brand { display: flex; align-items: center; gap: .625rem; font-weight: 600; }
    h1 { margin: 1.75rem 0 .5rem; font-size: 1.5rem; line-height: 1.35; font-weight: 600; }
    .error { color: var(--danger); }
    p { margin: 0; color: var(--cds-secondary); font-size: 1rem; line-height: 1.65; text-wrap: balance; }
    .service-name { white-space: nowrap; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><img src="${logo.trim()}" width="40" height="40" alt="">LXE Agent</div>
    <h1${state === "received" ? "" : ' class="error"'}>${title}</h1>
    <p>${detail}</p>
  </main>
</body>
</html>`);
}
