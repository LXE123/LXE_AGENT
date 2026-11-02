import * as Primitive from "@radix-ui/react-menu";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import "./primitives.css";

export function ActionMenu({ anchor, label, onClose, children }: {
  anchor: HTMLElement;
  label: string;
  onClose: (restoreFocus?: boolean) => void;
  children: ReactNode;
}) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!content) return;
    const frame = requestAnimationFrame(() => content.querySelector<HTMLElement>("[role='menuitem']:not([data-disabled])")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [content]);
  return <Primitive.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <Primitive.Anchor virtualRef={{ current: anchor }} />
    <Primitive.Portal>
      <Primitive.Content ref={setContent} className="session-actions-menu lxe-action-menu" aria-label={label}
        side="bottom" align="end" sideOffset={5} collisionPadding={8} loop
        onCloseAutoFocus={event => event.preventDefault()}
        onPointerDownOutside={event => {
          if (event.detail.originalEvent.target instanceof Node && anchor.contains(event.detail.originalEvent.target)) event.preventDefault();
          else { event.preventDefault(); onClose(false); }
        }}
        onFocusOutside={event => { event.preventDefault(); }}
        onKeyDown={event => { if (event.key === "Tab") { event.preventDefault(); onClose(); } }}>
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  </Primitive.Root>;
}

/** Keep async actions mounted until the business handler succeeds or shows its error. */
export function ActionMenuItem({ children, disabled, ...props }: ComponentProps<"button">) {
  return <Primitive.Item asChild disabled={disabled} onSelect={event => event.preventDefault()}>
    <button {...props} type="button" disabled={disabled}>{children}</button>
  </Primitive.Item>;
}
