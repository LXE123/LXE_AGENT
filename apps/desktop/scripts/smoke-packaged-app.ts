import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface DevToolsTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

const APP_CONFIGURATION_PREFIXES = ["LXE_", "AGENT_", "FEISHU_", "ZINIAO_", "MABANG_"] as const;
const APP_CONFIGURATION_NAMES = new Set([
  "KIMI_CODE_API_KEY",
  "DEEPSEEK_API",
  "GLM_API_KEY",
  "LOCAL_LOGS_ENABLED",
  "LOCAL_LOG_RETENTION_DAYS",
  "RUNTIME_LOG_LEVEL",
]);

export function packagedSmokeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { ...environment, ELECTRON_ENABLE_LOGGING: "1" };
  for (const name of Object.keys(childEnvironment)) {
    if (
      APP_CONFIGURATION_NAMES.has(name)
      || APP_CONFIGURATION_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) delete childEnvironment[name];
  }
  // The smoke verifies startup and setup persistence, not scheduled browser
  // authentication. Disabling it keeps the probe offline and deterministic.
  childEnvironment.LXE_MAINTENANCE_AUTH_ENABLED = "0";
  return childEnvironment;
}

export interface PackagedDesktopProbeResult {
  href: string;
  rendererState?: unknown;
  rootChildCount?: unknown;
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
    loggingDirectory?: unknown;
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

  let requestId = 0;
  const pending = new Map<number, {
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  const startupExceptions: string[] = [];
  let resolveLoad: (() => void) | undefined;

  socket.addEventListener("message", (event: MessageEvent) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error instanceof Error ? error : new Error(String(error)));
      pending.clear();
      return;
    }
    if (message.method === "Page.loadEventFired") resolveLoad?.();
    if (message.method === "Runtime.exceptionThrown") {
      const details = (message.params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      } | undefined)?.exceptionDetails;
      const description = details?.exception?.description || details?.text || "Uncaught Renderer exception";
      startupExceptions.push(description);
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    const protocolError = message.error as { message?: string } | undefined;
    if (protocolError) waiter.reject(new Error(protocolError.message || "DevTools protocol request failed"));
    else waiter.resolve(message);
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++requestId;
    const response = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return response;
  };

  const evaluate = async <T>(expression: string, awaitPromise = false): Promise<T> => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    const protocolResult = response.result as {
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      result?: { value?: T; description?: string };
    } | undefined;
    if (protocolResult?.exceptionDetails) {
      throw new Error(
        protocolResult.exceptionDetails.exception?.description
        || protocolResult.exceptionDetails.text
        || "DevTools evaluation failed",
      );
    }
    if (!protocolResult?.result || !("value" in protocolResult.result)) {
      throw new Error(protocolResult?.result?.description ?? "DevTools evaluation returned no value");
    }
    return protocolResult.result.value as T;
  };

  try {
    await withTimeout(send("Runtime.enable"), 5_000, "Runtime domain enable");
    await withTimeout(send("Page.enable"), 5_000, "Page domain enable");
    const loadEvent = new Promise<void>((resolvePromise) => { resolveLoad = resolvePromise; });
    await withTimeout(send("Page.reload", { ignoreCache: true }), 5_000, "Renderer reload");
    await withTimeout(loadEvent, 10_000, "Renderer load event");
    resolveLoad = undefined;

    type RendererProbe = {
      readyState: string;
      rootChildCount: number;
      rendererState: string;
      visibleText: string;
    };
    const deadline = Date.now() + Math.min(timeoutMilliseconds, 15_000);
    let rendererProbe: RendererProbe | undefined;
    while (Date.now() < deadline) {
      rendererProbe = await evaluate<RendererProbe>(`(() => {
        const root = document.getElementById("root");
        const stateNode = root?.querySelector("[data-lxe-root-state]");
        return {
          readyState: document.readyState,
          rootChildCount: root?.childElementCount || 0,
          rendererState: stateNode?.getAttribute("data-lxe-root-state") || "",
          visibleText: (root?.textContent || "").trim().slice(0, 240),
        };
      })()`);
      if (startupExceptions.length) {
        throw new Error(`Renderer raised an uncaught startup exception: ${startupExceptions.join(" | ")}`);
      }
      if (rendererProbe.rendererState === "fatal") {
        throw new Error(`Renderer entered the fatal startup state: ${rendererProbe.visibleText || "no detail"}`);
      }
      if (
        rendererProbe.rootChildCount > 0
        && (rendererProbe.rendererState === "setup" || rendererProbe.rendererState === "ready")
      ) break;
      await delay(100);
    }
    if (
      !rendererProbe
      || rendererProbe.rootChildCount === 0
      || (rendererProbe.rendererState !== "setup" && rendererProbe.rendererState !== "ready")
    ) {
      throw new Error(
        `Renderer did not reach a visible setup/ready state: ${JSON.stringify(rendererProbe ?? null)}`,
      );
    }

    const result = await withTimeout(evaluate<PackagedDesktopProbeResult>(`(async () => {
        const bridge = window.lxe;
        const result = {
          href: location.href,
          rendererState: document.querySelector("#root [data-lxe-root-state]")?.getAttribute("data-lxe-root-state"),
          rootChildCount: document.getElementById("root")?.childElementCount || 0,
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
              loggingDirectory: setupAfter?.logging?.directory,
            };
            result.postSaveHealth = await bridge.desktop.getHealth();
          } catch (error) {
            result.healthError = String(error);
          }
        }
        return result;
      })()`, true), timeoutMilliseconds, "preload bridge and setup evaluation");
    if (startupExceptions.length) {
      throw new Error(`Renderer raised an uncaught startup exception: ${startupExceptions.join(" | ")}`);
    }
    return result;
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error("DevTools WebSocket closed"));
    pending.clear();
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
  const expectedWorkspaceRoot = realpathSync.native(probeRoot);
  const dataRoot = join(dirname(executable), "var");
  if (existsSync(dataRoot)) {
    rmSync(probeRoot, { recursive: true, force: true });
    throw new Error(`Packaged desktop smoke requires a disposable app tree without existing state: ${dataRoot}`);
  }
  const childEnvironment = packagedSmokeEnvironment();
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--enable-logging=stderr",
  ], {
    env: childEnvironment,
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
    if (result.rendererState !== "setup" && result.rendererState !== "ready") {
      throw new Error(`Renderer state is ${String(result.rendererState)}`);
    }
    if (typeof result.rootChildCount !== "number" || result.rootChildCount < 1) {
      throw new Error(`Renderer root child count is ${String(result.rootChildCount)}`);
    }
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
    if (result.setupAfter.workspaceRoot !== expectedWorkspaceRoot) {
      throw new Error(
        `Desktop setup persisted an unexpected workspace: actual=${String(result.setupAfter.workspaceRoot)} expected=${expectedWorkspaceRoot}`,
      );
    }
    if (result.setupAfter.loggingProfile !== "standard") {
      throw new Error(`Desktop setup persisted an unexpected log profile: ${String(result.setupAfter.loggingProfile)}`);
    }
    if (result.setupAfter.loggingDirectory !== join(dataRoot, "logs")) {
      throw new Error(`Desktop setup exposed an unexpected log directory: ${String(result.setupAfter.loggingDirectory)}`);
    }
    if (!result.postSaveHealth || typeof result.postSaveHealth !== "object") {
      throw new Error("Desktop Gateway did not return health after the setup-triggered restart");
    }
    const logging = (result.postSaveHealth as {
      logging?: {
        desktop?: { local_file_enabled?: unknown; file_path?: unknown };
        agent_cli?: { local_file_enabled?: unknown; file_path?: unknown };
      };
    }).logging;
    for (const [name, expectedFile, status] of [
      ["desktop", "desktop.log", logging?.desktop],
      ["agent-cli", "runtime.log", logging?.agent_cli],
    ] as const) {
      if (status?.local_file_enabled !== true) throw new Error(`${name} logging sink is not enabled`);
      const filePath = String(status.file_path ?? "");
      if (!filePath.endsWith(expectedFile) || !existsSync(filePath)) {
        throw new Error(`${name} log file is unavailable: ${filePath}`);
      }
      const content = readFileSync(filePath, "utf8");
      const lines = content.trim().split(/\r?\n/u).filter(Boolean);
      if (lines.length === 0 || lines.some((line) => {
        try { JSON.parse(line); return false; } catch { return true; }
      })) {
        throw new Error(`${name} log file is not valid JSONL: ${filePath}`);
      }
      if (!content.includes('"message":"logging_configured"')) {
        throw new Error(`${name} log file is missing logging_configured`);
      }
      if (content.includes("packaged-smoke-placeholder-key")) {
        throw new Error(`${name} log file exposed the packaged smoke API key`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopProcessTree(child);
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
