import type { Logger } from "@lxe/core";
import type { DesktopConfigImportApplyResult, DesktopSetupState } from "@lxe/desktop-protocol";

type Environment = Record<string, string>;

export interface DesktopConfigImportApplicationOptions {
  importId: string;
  apply: (importId: string) => DesktopConfigImportApplyResult;
  currentEnvironment: () => Environment;
  currentState: () => DesktopSetupState;
  configureLogging: () => void;
  restartGateway: () => Promise<void>;
  stopGateway: () => Promise<void>;
  invalidateDashboard: () => void;
  broadcastHealth: () => void;
  logger: Logger;
  now?: () => number;
}

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export async function applyDesktopConfigImport(
  options: DesktopConfigImportApplicationOptions,
): Promise<DesktopConfigImportApplyResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const previousEnvironment = options.currentEnvironment();
  const wasComplete = options.currentState().complete;
  const result = options.apply(options.importId);
  options.configureLogging();
  const nextEnvironment = options.currentEnvironment();
  const runtimeConfigurationChanged = JSON.stringify(previousEnvironment) !== JSON.stringify(nextEnvironment);
  const restartRequired = result.state.complete && (!wasComplete || runtimeConfigurationChanged);
  const stopRequired = !result.state.complete;
  options.logger.info("config_import_persisted", {
    duration_ms: Math.max(0, now() - startedAt),
    setup_complete: result.state.complete,
    runtime_configuration_changed: runtimeConfigurationChanged,
    runtime_restart_required: restartRequired,
    runtime_stop_required: stopRequired,
    applied_group_count: result.applied_groups.length,
    pending_group_count: result.pending_groups.length,
    warning_count: result.warnings.length,
  });

  try {
    if (stopRequired || restartRequired) {
      const runtimeStartedAt = now();
      const action = stopRequired ? "stop" : "restart";
      options.logger.info("config_import_restart_started", {
        action,
        duration_ms: Math.max(0, runtimeStartedAt - startedAt),
      });
      try {
        if (stopRequired) await options.stopGateway();
        else await options.restartGateway();
        options.logger.info("config_import_restart_completed", {
          action,
          duration_ms: Math.max(0, now() - runtimeStartedAt),
        });
      } catch (cause) {
        options.logger.error("config_import_restart_failed", {
          action,
          duration_ms: Math.max(0, now() - runtimeStartedAt),
          error: cause,
        });
        throw new Error(
          `配置已保存，但服务${stopRequired ? "停止" : "重启"}失败：${errorMessage(cause)}`,
          { cause },
        );
      }
    }
    return result;
  } finally {
    options.invalidateDashboard();
    options.broadcastHealth();
  }
}
