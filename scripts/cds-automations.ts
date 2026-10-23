// Run from the repository root. This uses only an in-memory automation store and fake execution.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { startAutomationFixture } from "../apps/dashboard/test/features/automations/fixture-server";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "docs/design/cds/showcase/automations");
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
    resolve(root, "apps/dashboard/test/features/automations/cds-runner.cjs"), profile, fixture.url, output],
  { env, stdout: "pipe", stderr: "pipe" });
  timer = setTimeout(() => child?.kill(), 180_000);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (stderr) console.error(stderr);
  if (exitCode !== 0) console.log(stdout);
  if (exitCode !== 0) throw new Error(`Automation CDS verification exited ${exitCode}`);
  const result = stdout.split("\n").find(line => line.startsWith("LXE_AUTOMATIONS_CDS="));
  if (!result) throw new Error("Missing Electron verification result");
  const report = JSON.parse(result.slice("LXE_AUTOMATIONS_CDS=".length));
  if (report.passed.length < 24 || report.measurements.length < 60 || report.screenshots.length < 8) throw new Error("Incomplete automation state coverage");
  console.log(`Automation CDS: ${report.passed.length} checks, ${report.measurements.length} state measurements, ${report.screenshots.length} screenshots passed.`);
  rmSync(resolve(output, "failure.png"), { force: true });
  const files = ["apps/dashboard/src/features/automations/AutomationsPage.tsx", "apps/dashboard/src/features/automations/theme.css",
    "apps/dashboard/src/shared/cds-theme.css", "apps/dashboard/src/styles.css",
    "apps/dashboard/test/features/automations/fixture.tsx", "apps/dashboard/test/features/automations/fixture-server.ts",
    "apps/dashboard/test/features/automations/cds-runner.cjs", "scripts/cds-automations.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await Bun.file(resolve(root, file)).bytes()).digest("hex")])));
  await Bun.write(reportPath, JSON.stringify({ status: "passed", verifiedAt: new Date().toISOString(), sourceHashes,
    ...report, limitations: ["macOS 本地 Electron，生产页面配合内存数据和模拟执行；未连接账号或执行真实任务。",
      "原生日期、选择器、单选框保留系统渲染，未验证 Windows 视觉效果。",
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
