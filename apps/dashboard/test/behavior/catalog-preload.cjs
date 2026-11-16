const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("prepareCatalogFixture", action => ipcRenderer.invoke("lxe:workbench:team-skills-view", action));
contextBridge.exposeInMainWorld("catalogBrowserFixture", (ticket, command) => ipcRenderer.invoke("lxe:workbench:team-skills-browser", ticket, command));
