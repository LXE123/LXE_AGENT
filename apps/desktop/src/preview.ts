import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(desktopRoot, "..", "..");
const environment: Record<string, string | undefined> = { ...process.env };
delete environment.LXE_DASHBOARD_DEV_URL;
delete environment.LXE_DATA_ROOT;
environment.LXE_SOURCE_ROOT = sourceRoot;
environment.LXE_DESKTOP_PREVIEW = "1";

const electron = Bun.spawn(["bunx", "electron", "."], {
  cwd: desktopRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: environment,
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  electron.kill();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);

const exitCode = await electron.exited;
process.exit(exitCode);
