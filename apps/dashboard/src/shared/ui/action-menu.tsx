import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "./base/dropdown-menu";
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
  return <DropdownMenu open modal={false} loopFocus onOpenChange={(open, details) => {
    if (open) return;
    if (details.reason === "focus-out") { details.cancel(); return; }
    const target = details.event.target;
    if (details.reason === "outside-press" && target instanceof Node && anchor.contains(target)) {
      details.cancel(); return;
    }
    onClose(details.reason !== "outside-press");
  }}>
    <DropdownMenuContent ref={setContent} className="session-actions-menu lxe-action-menu" aria-label={label}
      side="bottom" align="end" sideOffset={5} finalFocus={false}
      positionerProps={{ anchor, collisionPadding: 8, className: "lxe-action-menu-positioner" }}
      onKeyDown={event => { if (event.key === "Tab") { event.preventDefault(); onClose(); } }}>
      {children}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Business handlers retain async errors in the open menu until accepted. */
export function ActionMenuItem({ children, disabled, onClick, ...props }: ComponentProps<"button">) {
  return <DropdownMenuItem nativeButton render={<button {...props} type="button" disabled={disabled} onClick={event => {
    // The business action may move focus to its dialog trigger. Keep Base UI's
    // item click handler from focusing this item again after that handoff.
    (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
    onClick?.(event);
  }} />}
    disabled={disabled} closeOnClick={false}>{children}</DropdownMenuItem>;
}
