import type { DesktopHealth } from "@lxe/desktop-protocol";
import type { AgentProcessStatus } from "@lxe/gateway/desktop";

export const desktopLxeSkillState = (
  status: AgentProcessStatus | undefined,
): DesktopHealth["lxeskill"] => {
  if (!status || status.state === "stopped") return "stopped";
  if (status.state === "starting") return "starting";
  if (status.state === "error") return "error";
  if (status.lxeskillAvailable === false) return "error";
  if (status.lxeskillAvailable === true) return "ready";
  return "error";
};
