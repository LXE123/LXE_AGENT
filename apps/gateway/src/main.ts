import { resolve } from "node:path";
import { configureLogging, createLogger } from "@lxe/core";
import { runGatewayCli, type GatewayApplicationPort } from "./cli";
import { loadProjectEnv } from "./env";
import { startEventLoopLagMonitor } from "./event-loop-lag";
import { GatewayStatusFiles } from "./planned-stop";
import { createProductionGateway } from "./production";

const logger = createLogger("gateway.main");

interface StopRequestOptions {
  timeoutMs?: number;
  pollMs?: number;
  pidExists?: (pid: number) => boolean;
  delay?: (milliseconds: number) => Promise<void>;
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function requestGatewayStop(
  projectRoot: string,
  options: StopRequestOptions = {},
): Promise<boolean> {
  const files = new GatewayStatusFiles({ projectRoot });
  const status = files.readStatus();
  if (!status) return false;
  const targetPid = Number(status.pid);
  const pidExists = options.pidExists ?? processExists;
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || !pidExists(targetPid)) return false;
  files.writePlannedStopMarker(status);
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
  const pollMs = Math.max(1, Math.trunc(options.pollMs ?? 100));
  const delay = options.delay ?? Bun.sleep;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(targetPid)) return true;
    await delay(pollMs);
  }
  return !pidExists(targetPid);
}

async function waitForShutdown(app: GatewayApplicationPort): Promise<void> {
  await new Promise<void>((resolveWait) => {
    let settled = false;
    let stopping = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveWait();
    };
    const onSignal = (): void => {
      if (stopping) {
        process.exitCode = 130;
        finish();
        return;
      }
      stopping = true;
      void app.stop().finally(finish);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const timer = setInterval(() => {
      void app.health().then((health) => {
        if (health.shutdown_started === true) finish();
      }).catch(() => undefined);
    }, 100);
  });
}

export async function main(arguments_: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const projectRoot = resolve(import.meta.dir, "../../..");
  const environment = loadProjectEnv({ projectRoot });
  const logging = configureLogging({ projectRoot, environment });
  const loggingEvent = {
    project_root: projectRoot,
    local_file_enabled: logging.status.localFileEnabled,
    runtime_log_path: logging.status.filePath ?? "",
    disabled_reason: logging.status.disabledReason ?? "",
    console_level: logging.status.consoleLevel,
    file_level: logging.status.fileLevel,
  };
  if (logging.status.disabledReason === "missing_log_file") {
    logger.warn("logging configured with no runtime log file", loggingEvent);
  } else {
    logger.info("logging configured", loggingEvent);
  }
  const onUnhandledRejection = (cause: unknown): void => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    logger.error("unhandled rejection", { error });
    process.exitCode = 1;
    void logging.flush().finally(() => {
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        // The process is already terminating.
      }
    });
  };
  const onUncaughtException = (cause: Error): void => {
    logger.error("uncaught exception", { error: cause });
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtExceptionMonitor", onUncaughtException);
  const lagMonitor = startEventLoopLagMonitor({ logger: createLogger("gateway.event_loop") });
  try {
    return await runGatewayCli(arguments_, {
      createApp: () => createProductionGateway({ projectRoot, environment }),
      requestStop: () => requestGatewayStop(projectRoot),
      waitForShutdown,
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    logger.error("fatal", { error });
    throw error;
  } finally {
    lagMonitor.stop();
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtExceptionMonitor", onUncaughtException);
    await logging.flush();
    await logging.close();
  }
}

if (import.meta.main) {
  try {
    const code = await main();
    if (!process.exitCode) process.exitCode = code;
  } catch {
    process.exitCode = 1;
  }
}
