import { contextBridge, ipcRenderer } from "electron";
import { isTeamSkillsPage } from "@lxe/desktop-protocol/team-skills";
import { IPC_CHANNELS } from "./ipc-channels";

if (process.isMainFrame && isTeamSkillsPage(location.href)) {
  contextBridge.exposeInMainWorld("lxeTeamSkills", {
    installedVersions: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.teamSkillVersions, ids),
    install: (id: string, version: string) => {
      if (!navigator.userActivation.isActive) throw new Error("请点击卡片上的安装或更新按钮");
      return ipcRenderer.invoke(IPC_CHANNELS.teamSkillInstall, id, version);
    },
  });
}
