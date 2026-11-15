import type { BrowserMount, ManualToolsBridge } from "@lxe/desktop-protocol";

const guests = new Map<string, HTMLIFrameElement>();

/** Move the connected iframe atomically so switching tabs preserves its guest. */
export function showBrowserGuest(viewport: HTMLElement, mount: BrowserMount, api: ManualToolsBridge): () => void {
  const { mountSrc } = mount;
  let frame = guests.get(mountSrc);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "sidebar-browser-frame";
    frame.title = mount.title || "Browser";
    viewport.appendChild(frame);
    const body = frame.contentDocument!.body;
    body.style.margin = "0";
    const webview = document.createElement("webview");
    webview.setAttribute("allowpopups", "");
    webview.setAttribute("src", mountSrc);
    webview.style.height = "100vh";
    body.appendChild(webview);
    const unsubscribe = api.subscribe(event => {
      if (event.kind !== "browser.release" || event.mountSrc !== mountSrc) return;
      unsubscribe();
      guests.get(mountSrc)?.remove();
      guests.delete(mountSrc);
    });
    guests.set(mountSrc, frame);
  } else viewport.moveBefore(frame, null);
  frame.hidden = false;
  return () => {
    if (frame.parentElement !== viewport) return;
    frame.hidden = true;
    document.body.moveBefore(frame, null);
  };
}
