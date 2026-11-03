import { useState, type ReactElement, type ReactNode } from "react";
import { Dialog as DialogRoot, DialogContent } from "./base/dialog";
import "./primitives.css";

/** Business forms own submission and errors; Base UI owns focus and dismissal. */
export function Dialog({ children, onClose, busy = false, backdropClassName = "session-delete-backdrop", descriptionId }: {
  children: ReactElement<{ children?: ReactNode; "aria-labelledby"?: string }>;
  onClose: () => void;
  busy?: boolean;
  backdropClassName?: string;
  descriptionId?: string;
}) {
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <DialogRoot open disablePointerDismissal onOpenChange={(open, details) => {
    if (busy) details.cancel();
    else if (!open) onClose();
  }}>
    <DialogContent render={children} showCloseButton={false} overlayClassName={backdropClassName}
      className="lxe-dialog-popup block gap-0 max-w-[calc(100%-3rem)] sm:max-w-[430px]"
      aria-labelledby={children.props["aria-labelledby"]} aria-describedby={descriptionId}
      finalFocus={() => returnFocus?.isConnected ? returnFocus : false}>
      {children.props.children}
    </DialogContent>
  </DialogRoot>;
}
