import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBridge } from "./preload-bridge";

const bridge = createDesktopBridge({
  invoke: (channel, ...arguments_) => ipcRenderer.invoke(channel, ...arguments_),
  on: (channel, listener) => { ipcRenderer.on(channel, listener); },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
});

contextBridge.exposeInMainWorld("lxe", bridge);
