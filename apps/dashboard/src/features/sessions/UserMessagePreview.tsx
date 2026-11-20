import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useUiText } from "../../shared/i18n";

const previewHeight = 200;

export function UserMessagePreview({ children, expanded, onToggle }: {
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useUiText().message;
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = body.current!;
    const measure = () => setOverflows(element.getBoundingClientRect().height > previewHeight);
    measure();
    // Observe the full body so wrapping, font changes and late content can all change the cutoff.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <>
    <div id={id} className="user-message-preview" data-truncated={overflows && !expanded || undefined}
      style={{ maxHeight: expanded ? undefined : previewHeight }}
      onFocusCapture={event => {
        if (!expanded && overflows && event.target.getBoundingClientRect().bottom > event.currentTarget.getBoundingClientRect().bottom) onToggle();
      }}>
      <div ref={body}>{children}</div>
    </div>
    {overflows && <button type="button" className="user-message-toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
      {expanded ? t.showLess : t.showMore}
    </button>}
  </>;
}
