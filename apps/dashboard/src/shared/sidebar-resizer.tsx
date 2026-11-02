import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUiText } from "./i18n";
import {
  initialSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, storeSidebarWidth,
} from "./sidebar-preference";

// Keep live drag updates here so the conversation does not rerender on every move.
export function SidebarResizer({ expanded, storage }: { expanded: boolean; storage?: Storage }) {
  const t = useUiText();
  const handle = useRef<HTMLDivElement>(null);
  const [preference, setPreference] = useState(() => initialSidebarWidth(storage));
  const preferenceRef = useRef(preference);
  const [room, setRoom] = useState(window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ element: HTMLDivElement; id: number; x: number; width: number } | null>(null);
  const frame = useRef<number | null>(null);
  const latestX = useRef(0);
  const maximum = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, room - 400));
  const width = Math.min(preference, maximum);

  useLayoutEffect(() => {
    const shell = handle.current!.parentElement!;
    const measure = () => setRoom(shell.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--app-sidebar-width");
      shell.removeAttribute("data-sidebar-resizing");
    };
  }, []);

  useLayoutEffect(() => {
    const shell = handle.current!.parentElement!;
    shell.style.setProperty("--app-sidebar-width", `${width}px`);
    shell.toggleAttribute("data-sidebar-resizing", dragging);
  }, [width, dragging]);

  const updateWidth = useCallback((next: number) => {
    const clamped = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(maximum, next)));
    preferenceRef.current = clamped;
    setPreference(clamped);
  }, [maximum]);

  const finish = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    setDragging(false);
    storeSidebarWidth(preferenceRef.current, storage);
  }, [storage]);

  useEffect(() => {
    if (!expanded) finish();
    return finish;
  }, [expanded, finish]);

  return (
    <div
      ref={handle}
      className="sidebar-resizer"
      hidden={!expanded}
      role="separator"
      tabIndex={0}
      aria-label={t.sidebar.resize}
      aria-controls="app-sidebar"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maximum}
      aria-valuenow={width}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        updateWidth(width + (event.key === "ArrowLeft" ? -10 : 10));
        storeSidebarWidth(preferenceRef.current, storage);
      }}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const renderedWidth = event.currentTarget.parentElement!
          .querySelector(".app-sidebar")!.getBoundingClientRect().width;
        drag.current = { element: event.currentTarget, id: event.pointerId, x: event.clientX, width: renderedWidth };
        setDragging(true);
      }}
      onPointerMove={event => {
        if (drag.current?.id !== event.pointerId) return;
        latestX.current = event.clientX;
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null;
          const active = drag.current;
          if (active) updateWidth(active.width + latestX.current - active.x);
        });
      }}
      onPointerUp={event => {
        const active = drag.current;
        if (active?.id !== event.pointerId) return;
        updateWidth(active.width + event.clientX - active.x);
        finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    />
  );
}
