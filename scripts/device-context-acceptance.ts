/** Isolated acceptance: actual desktop service + managed CLI + renderer component; no company server calls. */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DesktopCloudService } from "../apps/desktop/src/main/desktop-cloud";
import { DesktopCloudContextClient, CloudContextError } from "../apps/desktop/src/main/cloud-context";
import { DesktopConfigStore } from "../apps/desktop/src/main/config-store";
import { DesktopCloudEnrollmentManager } from "../apps/desktop/src/main/cloud-enrollment";
import { createLogger } from "../packages/foundation/core/src/logging";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "lxe-device-context-acceptance-"));
const artifacts = process.env.LXE_ACCEPTANCE_ARTIFACTS || join(tmpdir(), "lxe-device-context-acceptance");
const { mkdirSync } = await import("node:fs"); mkdirSync(artifacts, { recursive: true });
let scenario = "success";
const upstreamCalls: string[] = [];
const mock = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  upstreamCalls.push(new URL(req.url).pathname);
  if (new URL(req.url).pathname !== "/api/v1/device-context" || req.headers.get("authorization") || req.headers.get("cookie") || req.headers.get("X-LXE-Client") !== "cli") return new Response("Unexpected request", { status: 400 });
  if (scenario === "denied") return Response.json({ detail: "test device suspended" }, { status: 403 });
  if (scenario === "offline") return Response.json({ detail: "test server unavailable" }, { status: 503 });
  const id = scenario === "changed" ? "B" : "A";
  return Response.json({ response_schema: "lxe.device-context.v1", device: { id, kind: "managed_device", display_name: `验收设备 ${id}`, wireguard_ip: id === "A" ? "10.88.0.8" : "10.88.0.9" }, permission: {
    assignment_version: 1, profile: { id: "replenishment", revision: 4, labels: { "zh-CN": "备货", "en-US": "Replenishment" } },
    grants: { skill_types: ["amazon_fba", "replenishment", "amazon_operations", "shopee_operations", "ziniao_browser", "default"], desktop_features: ["erp_dashboard"], server_capabilities: ["mabang_read", "erp", "saihu"], erp_actions: ["purchase_import", "packing_confirm"] },
  } });
} });
const config = new DesktopConfigStore(temporary, join(temporary, "workspace"), {
  isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
}, { platform: "darwin" }); // Test storage only; production uses Electron safeStorage.
const cli = new DesktopCloudContextClient({ executablePath: join(root, ".venv", process.platform === "win32" ? "Scripts/lxeskill.exe" : "bin/lxeskill"), cwd: temporary });
const cloud = new DesktopCloudService({ dataRoot: temporary, config, supported: true,
  logger: createLogger("device-context-acceptance"), enrollments: new DesktopCloudEnrollmentManager(),
  provisioner: { provision: async () => { throw new Error("Unexpected provisioning"); } },
  onConfigured: async () => {}, fetch: Object.assign(async () => { throw new Error("Unexpected identity request"); }, {
    preconnect: () => { throw new Error("Unexpected identity preconnect"); },
  }),
  accessClient: { request: async () => ({ response_schema: "lxe.device-access.v1", management_role: "member", management_version: 1,
    device: { id: scenario === "changed" ? "B" : "A", kind: "managed_device", display_name: "Acceptance", wireguard_ip: scenario === "changed" ? "10.88.0.9" : "10.88.0.8" },
    managed_llm_v2: { revision: 1, default_target: null, models: [] },
  }) },
  contextClient: { query: (url, signal) => {
    if (url !== "http://10.88.0.1:8000") throw new CloudContextError("Unexpected company URL");
    return cli.query(`http://127.0.0.1:${mock.port}`, signal);
  } },
});
const entry = join(temporary, "view.tsx");
writeFileSync(entry, `import React from ${JSON.stringify(join(root, "apps/dashboard/node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(join(root, "apps/dashboard/node_modules/react-dom/client.js"))};
import { DeviceContextPanel } from ${JSON.stringify(join(root, "apps/dashboard/src/desktop/device-context-panel.tsx"))};
import { I18nContext, UI_TEXT } from ${JSON.stringify(join(root, "apps/dashboard/src/shared/i18n.tsx"))};
function App() { const [state, setState] = React.useState(null); const [busy, setBusy] = React.useState(false);
 async function run(action) { setBusy(true); try { setState(await (await fetch('/' + action, {method:'POST'})).json()); } finally { setBusy(false); } }
 React.useEffect(() => { run('refresh'); }, []);
 return <I18nContext.Provider value={UI_TEXT[new URLSearchParams(location.search).get('lang') || 'zh']}><main className="desktop-settings-section desktop-cloud-panel" style={{maxWidth: 960, margin:'40px auto',padding:24}}>{state && <DeviceContextPanel cloud={state} busy={busy} onRefresh={()=>run('refresh')} onConfirm={()=>run('confirm')} />}</main></I18nContext.Provider>;
} createRoot(document.getElementById('root')).render(<App/>);`);
const bundle = await Bun.build({ entrypoints: [entry], target: "browser", jsx: { runtime: "classic" } });
if (!bundle.success) throw new Error(String(bundle.logs));
const js = await bundle.outputs[0]!.text();
const css = readFileSync(join(root, "apps/dashboard/src/styles.css"), "utf8");
const page = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/scenario") { scenario = url.searchParams.get("value") || "success"; return new Response("ok"); }
  if (url.pathname === "/calls") return Response.json(upstreamCalls.length);
  if (url.pathname === "/refresh") return Response.json(await cloud.check());
  if (url.pathname === "/confirm") return Response.json(await cloud.confirmDevice());
  if (url.pathname === "/app.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (url.pathname === "/style.css") return new Response(css, { headers: { "content-type": "text/css" } });
  if (url.pathname !== "/") return new Response("Not found", { status: 404 });
  return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>', { headers: { "content-type": "text/html" } });
} });
const origin = `http://127.0.0.1:${page.port}`;
const electronScript = join(temporary, "acceptance.cjs");
writeFileSync(electronScript, `const {app,BrowserWindow,session}=require('electron'); const fs=require('fs');
app.setPath('userData',${JSON.stringify(join(temporary, "electron"))});
const base=${JSON.stringify(origin)};
const wait=async(w,text)=>{const until=Date.now()+15000;while(Date.now()<until){if(await w.webContents.executeJavaScript('document.body.innerText.includes('+JSON.stringify(text)+') && !document.querySelector("button:disabled")'))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+text);};
const click=async(w,text)=>w.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes('+JSON.stringify(text)+')).click()');
app.whenReady().then(async()=>{try {
 session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel: !d.url.startsWith(base+'/')}));
 const w=new BrowserWindow({show:true,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await w.loadURL(base); await wait(w,'已验证');
 const initialCalls=await w.webContents.executeJavaScript("fetch('/calls').then(r=>r.json())");
 const initialStorage=await w.webContents.executeJavaScript('JSON.stringify(localStorage)');
 if(await w.webContents.executeJavaScript('!!document.querySelector("details[open]")'))throw Error('Details initially open');
 if(await w.webContents.executeJavaScript('document.body.textContent.includes("10.88.0.1:8000")'))throw Error('Server address rendered');
 fs.writeFileSync(${JSON.stringify(join(artifacts, "permissions-zh.png"))},(await w.webContents.capturePage()).toPNG());
 w.focus(); w.webContents.focus();
 await w.webContents.executeJavaScript('document.querySelector(".device-permission-refresh").focus()');
 w.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'}); w.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
 await new Promise(r=>setTimeout(r,150));
 if(!await w.webContents.executeJavaScript('document.activeElement === document.querySelector(".device-permission-details summary")'))throw Error('Details not reachable by Tab');
 w.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'}); w.webContents.sendInputEvent({type:'char',keyCode:'\\r'}); w.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await wait(w,'马帮查询'); await new Promise(r=>setTimeout(r,200));
 if(!await w.webContents.executeJavaScript('document.querySelector(".device-permission-details").open'))throw Error('Keyboard did not open details');
 fs.writeFileSync(${JSON.stringify(join(artifacts, "permissions-zh-expanded.png"))},(await w.webContents.capturePage()).toPNG());
 if(await w.webContents.executeJavaScript('document.body.textContent.includes("10.88.0.1:8000")'))throw Error('Expanded details exposed server');
 w.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'}); w.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
 await new Promise(r=>setTimeout(r,100));
 if(await w.webContents.executeJavaScript('document.querySelector(".device-permission-details").open'))throw Error('Keyboard did not close details');
 if(await w.webContents.executeJavaScript("fetch('/calls').then(r=>r.json())")!==initialCalls)throw Error('Disclosure sent a context request');
 if(await w.webContents.executeJavaScript('JSON.stringify(localStorage)')!==initialStorage)throw Error('Disclosure persisted browser state');
 await w.webContents.executeJavaScript("fetch('/scenario?value=offline')"); await click(w,'刷新权限'); await wait(w,'使用缓存');
 if(await w.webContents.executeJavaScript('document.querySelector(".device-permission-error").open'))throw Error('Error initially open');
 fs.writeFileSync(${JSON.stringify(join(artifacts, "permissions-cache.png"))},(await w.webContents.capturePage()).toPNG());
 await w.webContents.executeJavaScript('document.querySelector(".device-permission-error summary").click()'); await wait(w,'test server unavailable');
 await w.webContents.executeJavaScript('document.querySelector(".device-permission-error summary").click()');
 await w.webContents.executeJavaScript("fetch('/scenario?value=changed')"); await click(w,'刷新权限'); await wait(w,'确认使用当前设备');
 fs.writeFileSync(${JSON.stringify(join(artifacts, "identity-change.png"))},(await w.webContents.capturePage()).toPNG());
 await click(w,'确认使用当前设备'); await wait(w,'已验证');
 if(await w.webContents.executeJavaScript('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("确认使用当前设备"))'))throw Error('Confirmation did not clear');
 await w.webContents.executeJavaScript("fetch('/scenario?value=denied')"); await click(w,'刷新权限'); await wait(w,'查询被拒绝');
 if(!await w.webContents.executeJavaScript('document.body.innerText.includes("已清空本地授权")'))throw Error('Denial is hidden');
 await w.webContents.executeJavaScript('document.querySelector(".device-permission-error summary").click()'); await wait(w,'test device suspended');
 if(await w.webContents.executeJavaScript('document.body.innerText.includes("马帮查询")'))throw Error('Denied grants remain');
 await w.webContents.executeJavaScript("fetch('/scenario?value=changed')"); await w.loadURL(base+'/?lang=en'); await wait(w,'Verified');
 w.setSize(430,900); await new Promise(r=>setTimeout(r,150));
 if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'))throw Error('Horizontal overflow');
 fs.writeFileSync(${JSON.stringify(join(artifacts, "permissions-en-mobile.png"))},(await w.webContents.capturePage()).toPNG());
 await w.webContents.executeJavaScript('document.querySelector(".device-permission-details summary").click()'); await wait(w,'Mabang queries'); await new Promise(r=>setTimeout(r,200));
 if(await w.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth'))throw Error('Expanded horizontal overflow');
 fs.writeFileSync(${JSON.stringify(join(artifacts, "permissions-en-mobile-expanded.png"))},(await w.webContents.capturePage()).toPNG());
 console.log('PASS: summary, keyboard disclosures, address omission, no toggle requests/storage, cache, identity confirmation, denial, English narrow layout'); w.destroy(); app.exit(0);
 }catch(e){console.error(e);app.exit(1);}});`);
try {
  const require = createRequire(join(root, "apps/desktop/package.json"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  // Resolve Electron itself from this worktree; the generated runner contains no credentials.
  env.NODE_PATH = join(root, "apps/desktop/node_modules");
  const child = Bun.spawn([require("electron"), electronScript], { env, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code) throw new Error(`Electron acceptance exited ${code}`);
  if (config.cloudConfiguration().managed || config.cloudIdentityCredential() || config.environment().LXE_DATA_SERVER_ENABLED !== "0") throw new Error("Discovery changed enrollment or upload configuration");
  console.log(JSON.stringify({ context_requests: upstreamCalls.length, only_context: upstreamCalls.every(p => p === "/api/v1/device-context"), artifacts }));
} finally { await cloud.stop(); page.stop(true); mock.stop(true); rmSync(temporary, { recursive: true, force: true }); }
