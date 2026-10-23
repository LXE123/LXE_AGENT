import { clearWorkspaceMembership, forgetWorkspace, projectWorkspaceData } from "./workspace-membership";
import { clearSessionTitles, projectSessionData } from "./session-titles";
// Desktop-only helpers shared by every Renderer view. Electron injects the
// sole transport through the narrow preload bridge.

import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DashboardTransport,
} from "@lxe/desktop-protocol";

let testTransport: DashboardTransport | undefined;

export function setDashboardTransportForTests(transport?: DashboardTransport): void {
  testTransport = transport;
  clearSessionTitles();
  clearWorkspaceMembership();
}

export interface DashboardRuntimeTransport {
  bridge?: DashboardTransport;
}

export function resolveDashboardTransport(runtime: DashboardRuntimeTransport): DashboardTransport {
  if (runtime.bridge) return runtime.bridge;
  throw new Error("Desktop preload bridge is unavailable");
}

export function dashboardTransport(): DashboardTransport {
  if (testTransport) return testTransport;
  const runtimeWindow = typeof window === "undefined" ? undefined : window;
  return resolveDashboardTransport({
    ...(runtimeWindow?.lxe?.dashboard ? { bridge: runtimeWindow.lxe.dashboard } : {}),
  });
}

export async function callDashboard<O extends DashboardRpcOperation>(
  call: DashboardRpcCall<O>,
): Promise<DashboardRpcResult<O>> {
  const result = await dashboardTransport().call(call);
  if (call.operation === "workspaces.delete") forgetWorkspace((call.input as { workspace_id: string }).workspace_id);
  return projectWorkspaceData(call.operation.startsWith("sessions.") ? projectSessionData(result) : result);
}
