import { contextBridge, ipcRenderer } from "electron";
import { isTeamSkillsPage, parseTeamInstallTicket, type TeamInstallTicket } from "@lxe/desktop-protocol/team-skills";
import { IPC_CHANNELS } from "./ipc-channels";

if (process.isMainFrame && isTeamSkillsPage(location.href)) {
  contextBridge.exposeInMainWorld("lxeTeamSkills", {
    installedVersions: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.teamSkillVersions, ids),
    install: async (id: string, version: string, getTicket: () => Promise<TeamInstallTicket>) => {
      // Check the click before waiting for the authenticated web request.
      if (!navigator.userActivation.isActive) throw new Error("请点击卡片上的安装或更新按钮");
      const ticket = parseTeamInstallTicket(await getTicket());
      if (ticket.skillId !== id || ticket.version !== version) throw new Error("下载凭据与技能卡片不符");
      return ipcRenderer.invoke(IPC_CHANNELS.teamSkillInstall, ticket);
    },
  });
}
