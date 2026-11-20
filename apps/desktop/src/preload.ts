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
  const bridge = createDesktopBridge(
    {
      invoke: (channel, ...arguments_) => ipcRenderer.invoke(channel, ...arguments_),
      on: (channel, listener) => { ipcRenderer.on(channel, listener); },
      removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
    },
    normalizeDesktopPlatform(process.platform),
    { getPathForFile: (file) => webUtils.getPathForFile(file) },
  );

  contextBridge.exposeInMainWorld("lxe", bridge);
}
