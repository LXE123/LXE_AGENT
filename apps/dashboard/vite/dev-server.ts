export const DEFAULT_DASHBOARD_DEV_PORT = 5173;

type Environment = Record<string, string | undefined>;

export function resolveDashboardDevPort(
  environment: Environment = process.env,
): number {
  const configuredPort = environment.LXE_DASHBOARD_DEV_PORT?.trim();
  if (!configuredPort) return DEFAULT_DASHBOARD_DEV_PORT;
  if (!/^\d+$/.test(configuredPort)) {
    throw new Error("LXE_DASHBOARD_DEV_PORT must be a valid TCP port");
  }

  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("LXE_DASHBOARD_DEV_PORT must be between 1024 and 65535");
  }
  return port;
}

export function dashboardDevUrl(environment: Environment = process.env): string {
  return `http://127.0.0.1:${resolveDashboardDevPort(environment)}`;
}
