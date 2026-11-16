const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("prepareCatalogFixture", action => ipcRenderer.invoke("lxe:workbench:team-skills-view", action));
