export interface DesktopStartupFailureReporter {
  writeStderr(message: string): void;
  showError(title: string, detail: string): void;
}

export const desktopStartupFailureDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const reportDesktopStartupFailure = (
  error: unknown,
  reporter: DesktopStartupFailureReporter,
): string => {
  const detail = desktopStartupFailureDetail(error);
  reporter.writeStderr(`LXE Agent startup failed: ${detail}\n`);
  reporter.showError("LXE Agent 无法启动", detail);
  return detail;
};
