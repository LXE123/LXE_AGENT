import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dashboardDevUrl, resolveDashboardDevPort } from "../../dashboard/vite/dev-server";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktopRoot, "..", "..");
const desktopEnvironment: Record<string, string | undefined> = { ...process.env };
delete desktopEnvironment.LXE_DATA_ROOT;
desktopEnvironment.LXE_SOURCE_ROOT = root;
desktopEnvironment.LXE_DASHBOARD_DEV_PORT = String(resolveDashboardDevPort(desktopEnvironment));
desktopEnvironment.LXE_DASHBOARD_DEV_URL = dashboardDevUrl(desktopEnvironment);
const dashboard = Bun.spawn([process.execPath, "run", "--cwd", "apps/dashboard", "dev"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: desktopEnvironment,
});

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(desktopEnvironment.LXE_DASHBOARD_DEV_URL);
    if (response.ok) break;
  } catch {
    // Vite is still starting.
  }
  await Bun.sleep(100);
}

const electron = Bun.spawn([process.execPath, "x", "electron", "."], {
  cwd: desktopRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: desktopEnvironment,
});

const stop = (): void => {
  electron.kill();
  dashboard.kill();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
await electron.exited;
dashboard.kill();
process.exit(electron.exitCode ?? 0);
