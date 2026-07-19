import type { DesktopConfigImportApplyResult } from "@lxe/desktop-protocol";

export const DESKTOP_SUCCESS_NOTICE_MS = 6_000;

export interface DesktopNoticeState {
  id: number;
  message: string;
  dismissible: boolean;
  autoDismissMs?: number;
}

export const desktopProgressNotice = (id: number, message: string): DesktopNoticeState => ({
  id,
  message,
  dismissible: false,
});

export const desktopSuccessNotice = (id: number, message: string): DesktopNoticeState => ({
  id,
  message,
  dismissible: true,
  autoDismissMs: DESKTOP_SUCCESS_NOTICE_MS,
});

export function configImportSuccessMessage(
  result: DesktopConfigImportApplyResult,
  unknownVariableCount: number,
): string {
  const imported = result.applied_groups.length > 0
    ? `已导入：${result.applied_groups.join("、")}`
    : "配置文件已处理";
  const pending = result.pending_groups.length > 0
    ? `；待补全：${result.pending_groups.join("、")}`
    : "";
  const skipped = unknownVariableCount > 0
    ? `；已跳过 ${unknownVariableCount} 个未知变量`
    : "";
  const warnings = result.warnings.length > 0
    ? `；${result.warnings.length} 项注意事项`
    : "";
  return `${imported}${pending}${skipped}${warnings}`;
}
