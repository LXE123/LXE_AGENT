// Local documentation preview and bounded Chromium verification. No production RPC.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep, relative } from "node:path";
import adaptation from "../docs/design/cds/current-adaptation.json";

const root = resolve(import.meta.dirname, "..");
const docs = resolve(root, "docs/design/cds");
const dashboard = resolve(root, "apps/dashboard");
const require = createRequire(resolve(dashboard, "package.json"));
const mode = process.argv[2] ?? "preview";
if (!["preview", "check", "docs"].includes(mode)) throw new Error("Usage: bun scripts/cds-gallery.ts [preview|check|docs]");
const hash = async (file: string) => createHash("sha256").update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest("hex");

async function writeDocs() {
  const lines = ["# 当前 CDS 适配总表", "", `整理日期：${adaptation.reviewedOn}。${adaptation.scope}`, "",
    "本表由 `current-adaptation.json` 生成。JSON 维护状态与证据对应关系；当前样式以链接的生产源码为准，历史变化通过 Git 查阅。", "",
    "## 如何打开与验证", "",
    "从仓库根执行 `bun run cds:preview`，打开输出的本地网址。页面并排展示亮暗主题，可输入、选择、Tab 聚焦和展开工具结果；预览 10 分钟后自动关闭，也可 Ctrl+C 结束。",
    "执行 `bun run cds:check` 会构建相同页面、运行本地 Electron 交互检查、保存截图和实测值，并关闭测试进程。命令失败时不得沿用旧记录声称通过。",
    "执行 `bun run cds:docs` 可核对原始出处片段并从 JSON 重建本表。", "",
    "入口源码：[展示页](../../../apps/dashboard/test/behavior/cds-gallery.tsx)、[布局样式](../../../apps/dashboard/test/behavior/cds-gallery.css)、[构建与验证](../../../scripts/cds-gallery.ts)。",
    "实测记录：[verification.json](showcase/verification.json)。记录内含实际源码 SHA-256、构建时 HEAD、浏览器版本与检查结果；后续代码改变需重新验证。", "",
    "## 证据等级", "",
    "- **原规则**：已取得文档明确说明；不外推到所有 Claude 页面。",
    "- **实现证据**：归档资源的具体代码与位置；没有抓取到的 Claude 运行时行为仍待验证。",
    "- **LXE 实测**：当前本地组件在示例数据下的计算样式与行为；不证明上游规则。",
    "- **探针**：为了暴露缺口而附加的原生属性；不代表生产流程已经支持。",
    "", `上游版本：${adaptation.upstreamVersion}。`, ""];
  for (const source of adaptation.sources) lines.push(`- **${source.id} · ${source.kind}**：[原文件](${relative(docs, resolve(root, source.file)).replaceAll("\\", "/")})，定位 \`${source.locator}\`。${source.note}`);
  for (const component of adaptation.components) {
    lines.push("", `## ${component.title}`, "", component.scope, "", `复用方式：**${component.reuse}**。${component.instructions}`, "",
      "源码：" + component.implementation.map(file => `[${file.split("/").at(-1)}](${relative(docs, resolve(root, file)).replaceAll("\\", "/")})`).join("、"), "",
      "| 状态 | CDS 依据 | LXE 当前实现 | 分类 |", "| --- | --- | --- | --- |");
    for (const state of component.states) lines.push(`| ${state.label} | ${state.upstream.join("、") || "无专用上游依据／本地接口"} | ${state.lxe} | ${state.classification} |`);
    lines.push("", "核对位置与验收：", "");
    for (const state of component.states) lines.push(`- **${state.id}**：\`${state.selector}\`。${state.verification}`);
    lines.push("", "尚未查清：", "", ...component.gaps.map(gap => `- ${gap}`));
  }
  lines.push("", "## 本轮实测的范围与限制", "", ...adaptation.limitations.map(note => `- ${note}`),
    "- 输入框未抽成独立 React 组件：样本使用与设置页相同的原生 input 和生产 CSS，容器只调整排布，不复制颜色规则；完整设置保存流程不在本轮范围。",
    "- 导航行与工具调用条直接导入生产 React 组件。上下文表面与主题作用域保留；样本外框、说明、检查器属于展示页。",
    "- 展示页使用独立 iframe 隔离亮暗主题，避免把根节点主题选择器错误地套到局部容器。",
    "- 检查包含输入框的错误＋焦点、导航的选中＋悬停／焦点、五类工具条状态的悬停／焦点／展开；禁用导航与禁用工具条标为不适用，不篡改 DOM 伪造接口。",
    "- 原始出处通过 source.slice(start, end) 与 excerpt 完整匹配校验；缺失证据不会由截图或测试通过来替代。",
    "", "## 待补证据清单", "",
    "1. Claude 会话导航专用规则：选中叠加 hover、键盘焦点、菜单打开时的优先级。",
    "2. Claude 工具调用条专用规则：五类执行状态、hover、focus 与展开状态的实际映射。",
    "3. Claude 输入框运行时：错误＋焦点、禁用叠加其他状态、不同表面上的最终合成颜色。",
    "4. LXE 后续改动候选：字段级错误接入、禁用语义变量、工具条遗留变量。它们在本任务仅记录，没有顺带修改产品外观。",
    "");
  await Bun.write(resolve(docs, "current-adaptation.md"), lines.join("\n"));
}
async function evidenceCheck() {
  const evidence = await Bun.file(resolve(docs, "sources/ion-settings/evidence-excerpts.json")).json();
  if (!evidence.entries?.length) throw new Error("No source evidence entries found");
  for (const item of evidence.entries) {
    const source = await Bun.file(resolve(docs, "sources/ion-settings", item.file)).text();
    if (source.slice(item.start, item.end) !== item.excerpt) throw new Error(`Evidence mismatch: ${item.id}`);
  }
  const ids = new Set(adaptation.sources.map(source => source.id));
  for (const component of adaptation.components) for (const state of component.states) for (const id of state.upstream) {
    if (!ids.has(id)) throw new Error(`Unknown source ${id}`);
  }
  return evidence.entries.length;
}
if (mode === "docs") {
  console.log(`Source excerpts verified: ${await evidenceCheck()}`);
  await writeDocs();
} else {
  const buildDir = mkdtempSync(resolve(tmpdir(), "lxe-cds-gallery-build-"));
  const profile = mkdtempSync(resolve(tmpdir(), "lxe-cds-gallery-profile-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = async () => {
    if (stopTimer) clearTimeout(stopTimer);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    server?.stop(true);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    rmSync(buildDir, { recursive: true, force: true, maxRetries: 5 });
  };
  process.once("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.once("SIGTERM", () => void cleanup().then(() => process.exit(0)));
  try {
    const { build } = await import(require.resolve("vite"));
    const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
    await build({ root: dashboard, configFile: false, base: "./", logLevel: "error",
      plugins: [react()], resolve: { dedupe: ["react", "react-dom"] },
      build: { outDir: buildDir, emptyOutDir: true, target: "es2022",
        rollupOptions: { input: resolve(dashboard, "test/behavior/cds-gallery.html") } } });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "GET") return new Response("Read-only gallery", { status: 405 });
      const url = new URL(request.url);
      const filePath = resolve(buildDir, "." + decodeURIComponent(url.pathname));
      if (!filePath.startsWith(buildDir + sep)) return new Response("Not found", { status: 404 });
      const file = Bun.file(filePath);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    } });
    const url = `http://127.0.0.1:${server.port}/test/behavior/cds-gallery.html`;
    console.log(`CDS gallery: ${url}`);
    if (mode === "preview") {
      console.log("Local sample data only. Preview closes in 10 minutes; Ctrl+C closes it now.");
      await new Promise<void>(done => { stopTimer = setTimeout(done, 600_000); });
    } else {
      const evidenceCount = await evidenceCheck();
      const output = resolve(docs, "showcase");
      mkdirSync(output, { recursive: true });
      // Never leave a previous successful report masquerading as this run.
      await Bun.write(resolve(output, "verification.json"), JSON.stringify({ status: "running", startedAt: new Date().toISOString(), report: "Current verification has not completed." }, null, 2) + "\n");
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      child = Bun.spawn([require(resolve(root, "apps/desktop/node_modules/electron")), resolve(dashboard, "test/behavior/cds-gallery-runner.cjs"), profile, url, output],
        { env, stdout: "pipe", stderr: "pipe" });
      stopTimer = setTimeout(() => child?.kill(), 90_000);
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      console.log(stdout); if (stderr) console.error(stderr);
      if (exitCode !== 0) throw new Error(`CDS gallery verification exited ${exitCode}`);
      const resultLine = stdout.split("\n").find(line => line.startsWith("LXE_CDS_RESULT="));
      if (!resultLine) throw new Error("Electron did not report completed checks");
      const report = JSON.parse(resultLine.slice("LXE_CDS_RESULT=".length));
      if (report.passed.length < 12 || report.measurements.length < 50) throw new Error("Incomplete verification coverage");
      const files = [...new Set([
        ...adaptation.components.flatMap(component => component.implementation),
        ...adaptation.sources.map(source => source.file),
        "apps/dashboard/src/shared/cds-theme.css",
        "apps/dashboard/test/behavior/cds-gallery.tsx", "apps/dashboard/test/behavior/cds-gallery.css",
        "apps/dashboard/test/behavior/cds-gallery-runner.cjs", "scripts/cds-gallery.ts",
        "docs/design/cds/current-adaptation.json",
      ])];
      const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
      if (head.exitCode !== 0) throw new Error("Cannot determine verification baseline");
      const fileHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, await hash(resolve(root, file))])));
      await Bun.write(resolve(output, "verification.json"), JSON.stringify({ status: "passed", verifiedAt: new Date().toISOString(),
        sourceHead: head.stdout.toString().trim(), sourceIdentification: "HEAD is the pre-commit baseline; SHA-256 identifies the actual working files checked.",
        sourceHashes: fileHashes, evidenceExcerptsVerified: evidenceCount,
        ...report, limitations: adaptation.limitations }, null, 2) + "\n");
      await writeDocs();
    }
  } catch (error) {
    if (mode === "check") {
      const output = resolve(docs, "showcase"); mkdirSync(output, { recursive: true });
      await Bun.write(resolve(output, "verification.json"), JSON.stringify({ status: "failed", failedAt: new Date().toISOString(), error: String(error) }, null, 2) + "\n");
    }
    throw error;
  } finally { await cleanup(); }
}
