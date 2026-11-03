import { useEffect, useRef, useState } from "react";
import { useUiText } from "../i18n";
import { Toast, ToastClose, ToastContent, ToastDescription, ToastProvider, ToastViewport, createToastManager, useToastManager } from "./base/toast";
import { IconButton } from "./icon-button";
import { X } from "lucide-react";
import "./error-notice.css";

export const ERROR_NOTICE_DURATION_MS = 6_000;

// Each failure owns an isolated library manager; replacing it cannot close a newer notice.
export function ErrorNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const [manager] = useState(() => createToastManager());
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    let active = true;
    manager.add({ id: "error", description: message, type: "error", onClose: () => { if (active) dismiss.current?.(); } });
    return () => { active = false; };
  }, [manager, message]);
  return <ToastProvider toastManager={manager} timeout={ERROR_NOTICE_DURATION_MS} limit={1}>
    <ErrorNoticeList />
  </ToastProvider>;
}

function ErrorNoticeList() {
  const t = useUiText();
  const { toasts } = useToastManager();
  return <ToastViewport className="dashboard-error-viewport" aria-label={`${t.errors.api} (F6)`}>
    {toasts.map(toast => <Toast key={toast.id} toast={toast} className="dashboard-query-notice dashboard-error-notice">
      <ToastContent className="dashboard-error-notice-content">
        <ToastDescription render={<span />} className="dashboard-error-notice-message" />
        <ToastClose render={<IconButton className="dashboard-error-notice-close" label={t.errors.dismiss} />}
          aria-label={t.errors.dismiss} className="dashboard-error-notice-close"><X size={16} /></ToastClose>
      </ToastContent>
    </Toast>)}
  </ToastViewport>;
}
