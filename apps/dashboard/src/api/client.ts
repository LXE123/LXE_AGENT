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
  return dashboardTransport().call(call);
}
