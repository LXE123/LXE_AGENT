export interface DashboardBrowserChild {
  readonly exited: Promise<number>;
  kill(): void;
}

export type DashboardBrowserSpawn = (
  command: readonly string[],
) => DashboardBrowserChild;

export interface DashboardBrowserOpener {
  open(url: string): Promise<boolean>;
}

export interface BunDashboardBrowserOpenerOptions {
  platform?: NodeJS.Platform;
  spawn?: DashboardBrowserSpawn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

const validateDashboardUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported Dashboard URL protocol: ${url.protocol}`);
  }
  return url.toString();
};

export function dashboardBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const target = validateDashboardUrl(url);
  if (platform === "darwin") return ["/usr/bin/open", target];
  if (platform === "win32") {
    return ["rundll32.exe", "url.dll,FileProtocolHandler", target];
  }
  if (platform === "linux") return ["xdg-open", target];
  throw new Error(`unsupported browser platform: ${platform}`);
}

const spawnBrowser: DashboardBrowserSpawn = (command) => Bun.spawn([...command], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  windowsHide: true,
});

export class BunDashboardBrowserOpener implements DashboardBrowserOpener {
  private readonly platform: NodeJS.Platform;
  private readonly spawn: DashboardBrowserSpawn;
  private readonly timeoutMs: number;

  constructor(options: BunDashboardBrowserOpenerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? spawnBrowser;
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  async open(url: string): Promise<boolean> {
    const child = this.spawn(dashboardBrowserCommand(url, this.platform));
    const timeout = Symbol("dashboard-browser-timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race<number | symbol>([
        child.exited,
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(timeout), this.timeoutMs);
        }),
      ]);
      if (result === timeout) {
        try {
          child.kill();
        } catch {
          // Browser launch failure must not affect Gateway startup.
        }
        throw new Error(`Dashboard browser opener timed out after ${this.timeoutMs}ms`);
      }
      return result === 0;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
