import { useEffect, type RefObject } from "react";

const SCROLLBAR_IDLE_MS = 800;

/** Share activity feedback between the workspace scroller and search results. */
export function useSidebarScrollbar(root: RefObject<HTMLElement | null>, visible: boolean) {
  useEffect(() => {
    const panel = root.current;
    if (!visible || !panel) return;
    let active: HTMLElement | null = null;
    let dragging: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      active?.removeAttribute("data-scrollbar-active");
      active = null;
    };
    const reveal = (element: HTMLElement) => {
      if (active !== element) hide();
      clearTimeout(timer);
      active = element;
      element.dataset.scrollbarActive = "true";
      if (dragging !== element) timer = setTimeout(hide, SCROLLBAR_IDLE_MS);
    };
    const scroll = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && element.matches(".sidebar-scroll-area")) reveal(element);
    };
    const pointerDown = (event: PointerEvent) => {
      const element = event.target;
      if (event.button !== 0 || event.pointerType === "touch" || !(element instanceof HTMLElement)
        || !element.matches(".sidebar-scroll-area") || element.scrollHeight <= element.clientHeight) return;
      // Only the native gutter starts a thumb/track interaction, not row clicks.
      const rect = element.getBoundingClientRect();
      if (event.clientX < rect.left + element.clientWidth) return;
      dragging = element;
      reveal(element);
    };
    const finishDrag = () => {
      const element = dragging;
      dragging = null;
      if (element?.isConnected) reveal(element);
    };
    const reset = () => { dragging = null; hide(); };

    // Scroll does not bubble; capture also covers a newly mounted search list.
    panel.addEventListener("scroll", scroll, true);
    panel.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("mouseup", finishDrag, true);
    window.addEventListener("pointercancel", finishDrag, true);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      panel.removeEventListener("scroll", scroll, true);
      panel.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("mouseup", finishDrag, true);
      window.removeEventListener("pointercancel", finishDrag, true);
      window.removeEventListener("blur", reset);
    };
  }, [root, visible]);
}
