import * as Primitive from "@radix-ui/react-dialog";
import { useState, type ReactElement } from "react";

/** Business forms own submission and errors; the primitive owns focus and dismissal. */
export function Dialog({ children, onClose, busy = false, backdropClassName = "session-delete-backdrop", descriptionId }: {
  children: ReactElement;
  onClose: () => void;
  busy?: boolean;
  backdropClassName?: string;
  descriptionId?: string;
}) {
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <Primitive.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Primitive.Portal>
      <Primitive.Overlay asChild>
        <div className={backdropClassName}>
          <Primitive.Content asChild aria-describedby={descriptionId}
            onPointerDownOutside={event => event.preventDefault()}
            onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
            onCloseAutoFocus={event => {
              event.preventDefault();
              if (returnFocus?.isConnected) returnFocus.focus();
            }}>
            {children}
          </Primitive.Content>
        </div>
      </Primitive.Overlay>
    </Primitive.Portal>
  </Primitive.Root>;
}
