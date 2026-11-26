import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createDesktopBridge } from "./preload-bridge";
import { normalizeDesktopPlatform } from "./platform";
import { IPC_CHANNELS } from "./ipc-channels";

if (process.isMainFrame) {
  // Capture precedes React's preview request. This channel is private to the preload.
  window.addEventListener("click", event => {
    if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.detail > 0 && window.getSelection()?.isCollapsed === false) return;
    const button = event.target.closest<HTMLButtonElement>(".conversation-feed button.markdown-file-link[data-linked-session][data-linked-path]");
    if (button) ipcRenderer.send(IPC_CHANNELS.clickedFileLink, button.dataset.linkedSession, button.dataset.linkedPath);
  }, true);
  // A popup for an external path must originate from that link's trusted gesture.
  let menuLink: { session: string; path: string } | undefined;
  window.addEventListener("contextmenu", event => {
    menuLink = undefined;
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>(".conversation-feed button.markdown-file-link[data-linked-session][data-linked-path]");
    if (!button?.dataset.linkedSession || !button.dataset.linkedPath) return;
    const link = { session: button.dataset.linkedSession, path: button.dataset.linkedPath };
    menuLink = link;
    setTimeout(() => { if (menuLink === link) menuLink = undefined; }, 0);
  }, true);
  const bridge = createDesktopBridge(
    {
      invoke: (channel, ...arguments_) => ipcRenderer.invoke(channel, ...arguments_),
      on: (channel, listener) => { ipcRenderer.on(channel, listener); },
      removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
    },
    normalizeDesktopPlatform(process.platform),
    { getPathForFile: (file) => webUtils.getPathForFile(file) },
    (session, path) => {
      const match = menuLink?.session === session && menuLink.path === path;
      menuLink = undefined;
      return match;
    },
  );

  contextBridge.exposeInMainWorld("lxe", bridge);
}
