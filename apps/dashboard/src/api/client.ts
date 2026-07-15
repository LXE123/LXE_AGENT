// Transport-neutral helpers shared by every view. The browser keeps the
// existing HTTP adapter; Electron injects a narrow preload bridge.

import type {
  DashboardTransport,
  DashboardTransportRequest,
} from "@lxe/desktop-protocol";
import type { JsonObject } from "@lxe/protocol";

export const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export class HttpDashboardTransport implements DashboardTransport {
  async request<T>(request: DashboardTransportRequest): Promise<T> {
    const response = await fetch(`${API_BASE}${request.path}`, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (body.detail) detail = String(body.detail);
      } catch {
        // Keep the HTTP status fallback.
      }
      throw new Error(detail);
    }
    return (await response.json()) as T;
  }
}

let testTransport: DashboardTransport | undefined;

export function setDashboardTransportForTests(transport?: DashboardTransport): void {
  testTransport = transport;
}

export function dashboardTransport(): DashboardTransport {
  return testTransport ?? window.lxe?.dashboard ?? new HttpDashboardTransport();
}

export async function fetchJson<T>(path: string): Promise<T> {
  return dashboardTransport().request<T>({ method: "GET", path });
}

export async function patchJson<T>(path: string, payload: JsonObject): Promise<T> {
  return dashboardTransport().request<T>({ method: "PATCH", path, body: payload });
}
