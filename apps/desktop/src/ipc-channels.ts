export const IPC_CHANNELS = {
  dashboardRequest: "lxe:dashboard:request",
  selectWorkspace: "lxe:desktop:select-workspace",
  getHealth: "lxe:desktop:get-health",
  restartAgent: "lxe:desktop:restart-agent",
  getSetupState: "lxe:desktop:get-setup-state",
  saveSetup: "lxe:desktop:save-setup",
  statusChanged: "lxe:desktop:status-changed",
} as const;
