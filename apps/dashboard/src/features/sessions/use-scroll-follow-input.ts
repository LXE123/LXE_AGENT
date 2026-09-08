import { useEffect, useRef, type RefObject } from "react";
import type React from "react";

export interface ScrollPosition { top: number; height: number; viewport: number }
const position = (element: HTMLElement): ScrollPosition => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight });
export const atLatestBottom = (value: ScrollPosition, latest: boolean) => latest && value.height - value.viewport - value.top <= 2;

/** A native input grants a short opportunity to resume; layout changes alone do not. */
export class BottomFollowGesture {
  private start?: ScrollPosition;
  begin(value: ScrollPosition) { this.start = value; }
  clear() { this.start = undefined; }
  get active() { return this.start !== undefined; }
  reachesBottom(value: ScrollPosition, latest: boolean): boolean {
    const start = this.start;
    if (!start) return false;
    // In particular, shrinking a picture/process or restoring a reading anchor
    // must not turn a preceding wheel event into permission to follow.
    if (value.height !== start.height || value.viewport !== start.viewport || value.top < start.top) {
      this.clear();
      return false;
    }
    return atLatestBottom(value, latest);
  }
}

function ownsScroll(root: HTMLElement, target: EventTarget | null, keyboard = false): boolean {
  if (!(target instanceof Element) || !root.contains(target)) return false;
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return false;
  if (keyboard && target.closest("button, a[href], [role=button], [role=slider]")) return false;
  for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return false;
  }
  return true;
}

export function useScrollFollowInput(root: RefObject<HTMLDivElement | null>, latest: boolean, onRead: () => void, onBottom: () => void) {
  const gesture = useRef(new BottomFollowGesture());
  const drag = useRef<number | undefined>(undefined);
  const touch = useRef<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const callbacks = useRef({ latest, onRead, onBottom });
  callbacks.current = { latest, onRead, onBottom };
  const clearGesture = () => {
    gesture.current.clear();
    if (timer.current !== undefined) clearTimeout(timer.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    timer.current = frame.current = undefined;
  };
  const clear = () => { clearGesture(); drag.current = touch.current = undefined; };
  const keepAlive = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(clearGesture, 500);
  };
  const check = () => {
    const element = root.current;
    if (drag.current !== undefined || !element || !gesture.current.reachesBottom(position(element), callbacks.current.latest)) return;
    clearGesture();
    callbacks.current.onBottom();
  };
  const down = () => {
    const element = root.current;
    if (!element) return;
    clearGesture();
    gesture.current.begin(position(element));
    // Also handles downward input at a clamped bottom, where no scroll fires.
    check();
    frame.current = requestAnimationFrame(() => { frame.current = undefined; check(); });
    // scrollend normally retires the gesture; this bounds keys/wheels that cause
    // no scrolling, and older engines without scrollend support.
    if (gesture.current.active) keepAlive();
  };
  const read = () => { clear(); callbacks.current.onRead(); };
  const direction = (delta: number) => { if (delta < 0) read(); else if (delta > 0) down(); };
  useEffect(() => {
    const finishDrag = () => {
      if (drag.current === undefined) return;
      drag.current = undefined;
      const element = root.current;
      if (element && atLatestBottom(position(element), callbacks.current.latest)) callbacks.current.onBottom();
    };
    const pointerUp = (event: PointerEvent) => { if (event.pointerId === drag.current) finishDrag(); };
    // Native touch panning cancels its pointer stream while touchmove continues.
    // Only cancel a scrollbar drag here; touchcancel owns cancelled touch input.
    const pointerCancel = (event: PointerEvent) => { if (event.pointerId === drag.current) clear(); };
    const scrollEnd = (event: Event) => { if (event.target === root.current) { check(); clearGesture(); } };
    const element = root.current;
    window.addEventListener("pointerup", pointerUp, true);
    // Some native scrollbar implementations swallow pointerup but deliver mouseup.
    window.addEventListener("mouseup", finishDrag, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("blur", clear);
    element?.addEventListener("scrollend", scrollEnd);
    return () => {
      clear();
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("mouseup", finishDrag, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("blur", clear);
      element?.removeEventListener("scrollend", scrollEnd);
    };
  }, [root]);
  return {
    clear,
    clearPending: clearGesture,
    onScroll: () => {
      check();
      // Touch/trackpad inertia can outlast the last input event. Only ongoing
      // movement of an already-authorized gesture extends this idle timeout.
      if (gesture.current.active) keepAlive();
    },
    handlers: {
      onWheelCapture(event: React.WheelEvent<HTMLDivElement>) {
        if (!root.current || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !ownsScroll(root.current, event.target)) return;
        direction(event.deltaY);
      },
      onTouchStartCapture(event: React.TouchEvent<HTMLDivElement>) {
        clear();
        if (root.current && event.touches.length === 1 && ownsScroll(root.current, event.target)) touch.current = event.touches[0]!.clientY;
      },
      onTouchMoveCapture(event: React.TouchEvent<HTMLDivElement>) {
        if (event.touches.length !== 1) { clear(); return; }
        const y = event.touches[0]!.clientY;
        if (touch.current !== undefined) { const delta = touch.current - y; direction(delta); touch.current = y; }
      },
      onTouchEndCapture() { touch.current = undefined; },
      onTouchCancelCapture: clear,
      onKeyDownCapture(event: React.KeyboardEvent<HTMLDivElement>) {
        if (!root.current || !ownsScroll(root.current, event.target, true)) return;
        const up = ["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey;
        const downKey = ["ArrowDown", "PageDown", "End", " "].includes(event.key);
        if (!up && !downKey) return;
        read();
        if (!up) down();
      },
      onPointerDownCapture(event: React.PointerEvent<HTMLDivElement>) {
        const element = root.current;
        if (event.pointerType === "touch" || event.button !== 0 || event.target !== element || !element || element.scrollHeight <= element.clientHeight) return;
        read();
        drag.current = event.pointerId;
      },
    },
  };
}
