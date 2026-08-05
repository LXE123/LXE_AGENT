export const DESKTOP_SUCCESS_NOTICE_MS = 6_000;

export interface DesktopNoticeState {
  id: number;
  message: string;
  dismissible: boolean;
  autoDismissMs?: number;
}

export const desktopSuccessNotice = (id: number, message: string): DesktopNoticeState => ({
  id,
  message,
  dismissible: true,
  autoDismissMs: DESKTOP_SUCCESS_NOTICE_MS,
});
