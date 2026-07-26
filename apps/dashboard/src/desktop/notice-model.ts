import type { DesktopConfigImportApplyResult } from "@lxe/desktop-protocol";
import type { UiText } from "../shared/i18n";

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
  text: UiText["desktop"],
  result: DesktopConfigImportApplyResult,
  unknownVariableCount: number,
): string {
  const imported = result.applied_groups.length > 0
    ? text.configImport.successImported(result.applied_groups.join(text.listSeparator))
    : text.configImport.successProcessed;
  const pending = result.pending_groups.length > 0
    ? text.configImport.successPending(result.pending_groups.join(text.listSeparator))
    : "";
  const skipped = unknownVariableCount > 0
    ? text.configImport.successSkipped(String(unknownVariableCount))
    : "";
  const warnings = result.warnings.length > 0
    ? text.configImport.successWarnings(String(result.warnings.length))
    : "";
  return `${imported}${pending}${skipped}${warnings}`;
}
