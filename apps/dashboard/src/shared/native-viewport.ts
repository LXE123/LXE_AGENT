import type { NativeViewBounds } from "@lxe/desktop-protocol";

/** Native child views sit above the DOM. Let dashboard menus and dialogs take precedence. */
export function observeNativeViewport(element: HTMLElement, present: (bounds: NativeViewBounds | null) => void) {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const overlays = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], .app-sidebar.is-peek, .sidebar-dismiss');
      const blocked = document.hidden || Array.from(overlays).some(el => el.getClientRects().length > 0);
      const { x, y, width, height } = element.getBoundingClientRect();
      present(blocked || !width || !height ? null : { x, y, width, height });
    });
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(element);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "open", "role", "hidden"] });
  window.addEventListener("resize", schedule);
  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", schedule);
  schedule();
  return () => {
    resize.disconnect();
    mutations.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("focus", schedule);
    document.removeEventListener("visibilitychange", schedule);
  };
}
