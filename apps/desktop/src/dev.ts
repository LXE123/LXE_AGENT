const root = new URL("../../..", import.meta.url).pathname;
const dashboard = Bun.spawn(["bun", "run", "--cwd", "apps/dashboard", "dev"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://127.0.0.1:5173");
    if (response.ok) break;
  } catch {
    // Vite is still starting.
  }
  await Bun.sleep(100);
}

const electron = Bun.spawn(["bunx", "electron", "."], {
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    LXE_SOURCE_ROOT: root,
    LXE_DASHBOARD_DEV_URL: "http://127.0.0.1:5173",
  },
});

const stop = (): void => {
  electron.kill();
  dashboard.kill();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
await electron.exited;
dashboard.kill();
process.exit(electron.exitCode ?? 0);
