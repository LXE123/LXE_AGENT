const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("prepareCatalogFixture", () => ipcRenderer.invoke("lxe:workbench:prepare-team-skills"));
