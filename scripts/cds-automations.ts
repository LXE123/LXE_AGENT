// Run from the repository root. This uses only an in-memory automation store and fake execution.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { startAutomationFixture } from "../apps/dashboard/test/features/automations/fixture-server";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "docs/design/cds/showcase/automations", process.platform === "win32" ? "windows" : ".");
const profile = mkdtempSync(resolve(tmpdir(), "lxe-automations-cds-"));
mkdirSync(output, { recursive: true });
const reportPath = resolve(output, "verification.json");
await Bun.write(reportPath, JSON.stringify({ status: "running", startedAt: new Date().toISOString() }, null, 2) + "\n");
let fixture: Awaited<ReturnType<typeof startAutomationFixture>> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  fixture = await startAutomationFixture();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = Bun.spawn([require(resolve(root, "apps/desktop/node_modules/electron")),
    // Electron on Windows rejects arguments after a URL; keep the URL last.
    resolve(root, "apps/dashboard/test/features/automations/cds-runner.cjs"), profile, output, fixture.url],
  { env, stdout: "pipe", stderr: "pipe" });
  timer = setTimeout(() => child?.kill(), 180_000);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (stderr) console.error(stderr);
  if (exitCode !== 0) console.log(stdout);
  if (exitCode !== 0) throw new Error(`Automation CDS verification exited ${exitCode}`);
  const result = stdout.split("\n").find(line => line.startsWith("LXE_AUTOMATIONS_CDS="));
  if (!result) throw new Error("Missing Electron verification result");
  const report = JSON.parse(result.slice("LXE_AUTOMATIONS_CDS=".length));
  if (report.surface !== "desktop-shell" || report.passed.length < 32 || report.measurements.length < 86 || report.screenshots.length < 20) throw new Error("Incomplete automation desktop shell/state coverage");
  console.log(`Automation CDS: ${report.passed.length} checks, ${report.measurements.length} state measurements, ${report.screenshots.length} screenshots passed.`);
  rmSync(resolve(output, "failure.png"), { force: true });
  const files = ["apps/dashboard/src/features/automations/AutomationsPage.tsx", "apps/dashboard/src/features/automations/theme.css",
    "apps/dashboard/src/features/automations/AutomationResumeDialog.tsx",
    "apps/dashboard/src/shared/cds-theme.css", "apps/dashboard/src/styles.css", "apps/dashboard/src/main.tsx",
    "apps/dashboard/src/features/capabilities/theme.css", "apps/dashboard/src/shared/navigation-rail.css",
    "apps/dashboard/test/behavior/renderer.tsx",
    "apps/dashboard/test/features/automations/fixture.tsx", "apps/dashboard/test/features/automations/fixture-server.ts",
    "apps/dashboard/test/features/automations/cds-runner.cjs", "scripts/cds-automations.ts"];
  // Git may check out CRLF on Windows. Compare the same UTF-8/LF source across platforms.
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash("sha256").update((await Bun.file(resolve(root, file)).text()).replace(/\r\n/g, "\n"), "utf8").digest("hex")])));
  await Bun.write(reportPath, JSON.stringify({ status: "passed", verifiedAt: new Date().toISOString(), sourceHashFormat: "sha256-utf8-lf", sourceHashes,
    platform: process.platform, arch: process.arch, ...report,
    limitations: ["本机 Electron 加载完整桌面布局和生产页面，接口配合内存数据和模拟执行；未连接账号或执行真实任务，不代表安装包验收。",
      "原生日期、选择器、单选框保留系统渲染；验收只覆盖报告记录的平台。",
      "不代表全站 CDS、全量读屏或触屏审计。"] }, null, 2) + "\n");
} catch (cause) {
  await Bun.write(reportPath, JSON.stringify({ status: "failed", failedAt: new Date().toISOString(), error: String(cause) }, null, 2) + "\n");
  throw cause;
} finally {
  if (timer) clearTimeout(timer);
  if (child && child.exitCode === null) { child.kill(); await child.exited; }
  await fixture?.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
