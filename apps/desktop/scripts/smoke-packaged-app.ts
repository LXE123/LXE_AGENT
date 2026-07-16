import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface DevToolsTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface PackagedDesktopProbeResult {
  href: string;
  lxeType: string;
  lxeKeys: string[];
  dashboardType: string;
  desktopType: string;
  platform?: unknown;
  health?: unknown;
  healthError?: string;
  setupBeforeComplete?: unknown;
  setupAfter?: {
    complete?: unknown;
    provider?: unknown;
    providerKeyConfigured?: unknown;
    workspaceRoot?: unknown;
    loggingProfile?: unknown;
  };
  postSaveHealth?: unknown;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const withTimeout = async <T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolvePromise, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const reservePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a DevTools port");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return address.port;
};

const findPageTarget = async (
  child: ChildProcessWithoutNullStreams,
  port: number,
  timeoutMilliseconds: number,
): Promise<DevToolsTarget> => {
  const deadline = Date.now() + timeoutMilliseconds;
  let stableTargetUrl: string | undefined;
  let stableObservations = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged desktop exited before DevTools became ready (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        const targets = await response.json() as DevToolsTarget[];
        const page = targets.find((target) =>
          target.type === "page"
          && target.url === "app://lxe/"
          && Boolean(target.webSocketDebuggerUrl));
        if (page) {
          if (page.webSocketDebuggerUrl === stableTargetUrl) {
            stableObservations += 1;
          } else {
            stableTargetUrl = page.webSocketDebuggerUrl;
            stableObservations = 1;
          }
          // Attaching while Electron is still creating a sandboxed renderer can
          // race preload startup on Windows. Require a stable target rather than
          // sleeping blindly or retrying a failed bridge evaluation.
          if (stableObservations >= 5) return page;
        } else {
          stableTargetUrl = undefined;
          stableObservations = 0;
        }
      }
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error(`Packaged desktop DevTools did not become ready within ${timeoutMilliseconds}ms`);
};

const evaluateBridge = async (
  webSocketDebuggerUrl: string,
  workspaceRoot: string,
  timeoutMilliseconds: number,
): Promise<PackagedDesktopProbeResult> => {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await withTimeout(new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket failed to open")), { once: true });
  }), 5_000, "DevTools WebSocket connection");

  const requestId = 1;
  const responsePromise = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const onMessage = (event: MessageEvent): void => {
      try {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.id !== requestId) return;
        socket.removeEventListener("message", onMessage);
        resolvePromise(message);
      } catch (error) {
        socket.removeEventListener("message", onMessage);
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage);
  });

  socket.send(JSON.stringify({
    id: requestId,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        const bridge = window.lxe;
        const result = {
          href: location.href,
          lxeType: typeof bridge,
          lxeKeys: bridge ? Object.keys(bridge).sort() : [],
          dashboardType: typeof bridge?.dashboard,
          desktopType: typeof bridge?.desktop,
          platform: bridge?.desktop?.platform,
        };
        if (bridge) {
          try {
            result.health = await bridge.desktop.getHealth();
            const setupBefore = await bridge.desktop.getSetupState();
            result.setupBeforeComplete = setupBefore?.complete;
            const setupAfter = await bridge.desktop.saveSetup({
              provider: "kimi_coding",
              api_key: "packaged-smoke-placeholder-key",
              workspace_root: ${JSON.stringify(workspaceRoot)},
              logging: { profile: "standard", retention_days: 7 },
            });
            result.setupAfter = {
              complete: setupAfter?.complete,
              provider: setupAfter?.provider,
              providerKeyConfigured: setupAfter?.provider_key_configured,
              workspaceRoot: setupAfter?.workspace_root,
              loggingProfile: setupAfter?.logging?.profile,
            };
            result.postSaveHealth = await bridge.desktop.getHealth();
          } catch (error) {
            result.healthError = String(error);
          }
        }
        return result;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  }));

  try {
    const response = await withTimeout(
      responsePromise,
      timeoutMilliseconds,
      "preload bridge and setup evaluation",
    );
    const protocolResult = response.result as {
      exceptionDetails?: { text?: string };
      result?: { value?: PackagedDesktopProbeResult; description?: string };
    } | undefined;
    if (protocolResult?.exceptionDetails) {
      throw new Error(protocolResult.exceptionDetails.text ?? "DevTools evaluation failed");
    }
    const result = protocolResult?.result?.value;
    if (!result) {
      throw new Error(protocolResult?.result?.description ?? "DevTools evaluation returned no value");
    }
    return result;
  } finally {
    socket.close();
  }
};

const stopProcessTree = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
      delay(2_000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
      delay(5_000),
    ]);
  }
  // Windows can retain an already-terminated Electron child in the process
  // table briefly after taskkill returns. Let process cleanup settle before
  // deleting Chromium state or returning success to the packaging pipeline.
  if (process.platform === "win32") await delay(500);
};

export async function smokePackagedDesktop(
  executablePath: string,
  timeoutMilliseconds = 30_000,
): Promise<PackagedDesktopProbeResult> {
  const executable = resolve(executablePath);
  const port = await reservePort();
  const probeRoot = mkdtempSync(join(tmpdir(), "lxe-packaged-desktop-smoke-"));
  const dataRoot = join(probeRoot, "data");
  const userDataRoot = join(probeRoot, "chromium");
  const child = spawn(executable, [
    `--user-data-dir=${userDataRoot}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--enable-logging=stderr",
  ], {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      LXE_DATA_ROOT: dataRoot,
    },
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  let result: PackagedDesktopProbeResult | undefined;
  let failure: unknown;
  try {
    const target = await findPageTarget(child, port, timeoutMilliseconds);
    result = await evaluateBridge(target.webSocketDebuggerUrl!, probeRoot, timeoutMilliseconds);
    if (result.href !== "app://lxe/") throw new Error(`Unexpected renderer URL: ${result.href}`);
    if (result.lxeType !== "object") throw new Error(`window.lxe is ${result.lxeType}`);
    if (result.dashboardType !== "object") throw new Error(`window.lxe.dashboard is ${result.dashboardType}`);
    if (result.desktopType !== "object") throw new Error(`window.lxe.desktop is ${result.desktopType}`);
    if (result.platform !== "win32" && result.platform !== "darwin" && result.platform !== "linux") {
      throw new Error(`window.lxe.desktop.platform is ${String(result.platform)}`);
    }
    if (!result.lxeKeys.includes("dashboard") || !result.lxeKeys.includes("desktop")) {
      throw new Error(`window.lxe exposes unexpected keys: ${result.lxeKeys.join(", ")}`);
    }
    if (result.healthError) throw new Error(`Desktop health IPC failed: ${result.healthError}`);
    if (!result.health || typeof result.health !== "object") {
      throw new Error("Desktop health IPC returned no object");
    }
    if (result.setupAfter?.complete !== true || result.setupAfter.providerKeyConfigured !== true) {
      throw new Error(`Desktop setup did not become complete: ${JSON.stringify(result.setupAfter)}`);
    }
    if (result.setupAfter.provider !== "kimi_coding") {
      throw new Error(`Desktop setup persisted an unexpected provider: ${String(result.setupAfter.provider)}`);
    }
    if (result.setupAfter.workspaceRoot !== probeRoot) {
      throw new Error(`Desktop setup persisted an unexpected workspace: ${String(result.setupAfter.workspaceRoot)}`);
    }
    if (result.setupAfter.loggingProfile !== "standard") {
      throw new Error(`Desktop setup persisted an unexpected log profile: ${String(result.setupAfter.loggingProfile)}`);
    }
    if (!result.postSaveHealth || typeof result.postSaveHealth !== "object") {
      throw new Error("Desktop Gateway did not return health after the setup-triggered restart");
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopProcessTree(child);
    rmSync(probeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const preloadFailure = stderr.match(/Unable to load preload script|Cannot use import statement outside a module/iu);
  if (!failure && preloadFailure) failure = new Error(preloadFailure[0]);
  if (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    throw new Error([
      `Packaged desktop smoke failed: ${detail}`,
      stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    ].filter(Boolean).join("\n"));
  }
  if (!result) throw new Error("Packaged desktop smoke returned no result");
  return result;
}

if (import.meta.main) {
  const executable = process.argv[2];
  if (!executable) throw new Error("Usage: bun scripts/smoke-packaged-app.ts <desktop-executable>");
  const result = await smokePackagedDesktop(executable);
  process.stdout.write(`Packaged desktop preload/IPC smoke OK: ${JSON.stringify(result)}\n`);
}
