import {
  configureLogging,
  createLogger,
  type LoggingController,
  type LoggingStatus,
} from "@lxe/core";
import type { DesktopLoggingSinkStatus } from "@lxe/desktop-protocol";

type Environment = Record<string, string | undefined>;

const logger = createLogger("desktop.main");

export const desktopLoggingStatus = (status: LoggingStatus): DesktopLoggingSinkStatus => ({
  local_file_enabled: status.localFileEnabled,
  file_path: status.filePath ?? "",
  disabled_reason: status.disabledReason ?? "",
  last_error: status.lastError ?? "",
  console_level: status.consoleLevel,
  file_level: status.fileLevel,
});

export interface DesktopLoggingManagerOptions {
  dataRoot: string;
  environment(): Environment;
  onStatusChange?(status: DesktopLoggingSinkStatus): void;
}

export class DesktopLoggingManager {
  private controller: LoggingController | undefined;

  constructor(private readonly options: DesktopLoggingManagerOptions) {}

  configure(): DesktopLoggingSinkStatus {
    this.controller = configureLogging({
      projectRoot: this.options.dataRoot,
      stateRoot: this.options.dataRoot,
      environment: {
        ...this.options.environment(),
        LOG_FILE: "desktop.log",
      },
      onStatusChange: (status) => this.notify(desktopLoggingStatus(status)),
    });
    const status = this.status();
    logger.info("logging_configured", {
      process: "desktop",
      local_file_enabled: status.local_file_enabled,
      runtime_log_path: status.file_path,
      disabled_reason: status.disabled_reason,
      console_level: status.console_level,
      file_level: status.file_level,
    });
    this.notify(status);
    return status;
  }

  status(): DesktopLoggingSinkStatus {
    const status = this.controller?.status;
    return status
      ? desktopLoggingStatus(status)
      : {
          local_file_enabled: false,
          file_path: "",
          disabled_reason: "disabled_by_config",
          last_error: "",
          console_level: "info",
          file_level: "debug",
        };
  }

  async close(): Promise<void> {
    const controller = this.controller;
    this.controller = undefined;
    if (!controller) return;
    await controller.flush();
    await controller.close();
  }

  private notify(status: DesktopLoggingSinkStatus): void {
    try {
      this.options.onStatusChange?.(status);
    } catch {
      // Status presentation must not affect logging or Desktop execution.
    }
  }
}
