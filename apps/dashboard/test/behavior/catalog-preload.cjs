const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("onCatalogNavigationError", listener => {
  const handler = (_event, message) => listener(message);
  ipcRenderer.on("lxe:workbench:team-skills-navigation-error", handler);
  return () => ipcRenderer.removeListener("lxe:workbench:team-skills-navigation-error", handler);
});
contextBridge.exposeInMainWorld("prepareCatalogFixture", () => ipcRenderer.invoke("lxe:workbench:prepare-team-skills"));
