import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDesktopPaths } from "../apps/desktop/src/main/paths";
import { execRuntimeEnvironment, resolveExecRuntimePaths } from "../apps/agent-cli/src/exec-paths";
import { CodingPathPolicy } from "../packages/agent/runtime/src/tooling/coding/path-policy";
import { createSearchTools } from "../packages/agent/runtime/src/tooling/coding/search-tools";
import { checkFdVersion } from "../packages/agent/runtime/src/tooling/fd-search";
import { ToolRegistry } from "../packages/agent/runtime/src/tooling/registry";

// Run with the absolute Bun executable: the child test can then remove system PATH.
const unpacked = resolve(process.argv[2] || "dist/desktop-unpacked/win-unpacked");
const scratch = mkdtempSync(join(tmpdir(), "lxe-packaged-fd-"));
const previousPath = process.env.PATH;
const previousFd = process.env.LXE_FD_PATH;
try {
  const resources = join(unpacked, "resources");
  const desktop = resolveDesktopPaths({ packaged: true, appPath: join(resources, "app.asar"), executablePath: join(unpacked, "LXE Agent.exe"), resourcesPath: resources, environment: {} });
  const paths = resolveExecRuntimePaths({ executablePath: join(resources, "runtime/agent-cli/agent-cli.exe"), moduleDirectory: scratch, environment: {} });
  if (desktop.fdPath !== paths.fdPath) throw new Error("Desktop and agent-cli disagree on packaged fd path");
  if (!existsSync(paths.fdPath)) throw new Error(`Missing packaged fd: ${paths.fdPath}`);
  const env = execRuntimeEnvironment({ ...paths, dataRoot: scratch }, join(scratch, "unused.sqlite3"), {});
  process.env.PATH = "";
  process.env.LXE_FD_PATH = env.LXE_FD_PATH;
  checkFdVersion(paths.fdPath);
  mkdirSync(join(scratch, "src"));
  writeFileSync(join(scratch, "src", "sample.ts"), "export const sample = 1;\n");
  writeFileSync(join(scratch, "src", "sample.txt"), "not selected\n");
  const registry = new ToolRegistry();
  for (const tool of createSearchTools({ paths: new CodingPathPolicy(), toolOutputLimit: 10_000 })) registry.register(tool);
  const result = await registry.execute("find", { pattern: "**/*.ts", path: "src" }, {
    session_id: "packaged-fd-smoke", workspace: { directory: scratch, worktree: scratch },
    handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
  });
  if (result.content[0]?.text !== "src/sample.ts") throw new Error(`Unexpected packaged find output: ${JSON.stringify(result.content)}`);
  console.log(JSON.stringify({ status: "passed", fd: paths.fdPath, systemPath: "empty", result: result.content[0].text }));
} finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousFd === undefined) delete process.env.LXE_FD_PATH; else process.env.LXE_FD_PATH = previousFd;
  rmSync(scratch, { recursive: true, force: true });
}
