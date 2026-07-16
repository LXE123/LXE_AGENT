// Transport-neutral helpers shared by every view. The browser keeps the
// existing HTTP adapter; Electron injects a narrow preload bridge.

import type {
  DashboardTransport,
  DashboardTransportRequest,
} from "@lxe/desktop-protocol";
import type { JsonObject } from "@lxe/protocol";

export const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

const isJsonContentType = (contentType: string | null): boolean => {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
};

export class HttpDashboardTransport implements DashboardTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async request<T>(request: DashboardTransportRequest): Promise<T> {
    const response = await this.fetcher(`${API_BASE}${request.path}`, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
    });
    const contentType = response.headers.get("content-type");
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      if (isJsonContentType(contentType)) {
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (body.detail) detail = String(body.detail);
        } catch {
          // Keep the HTTP status fallback.
        }
      }
      throw new Error(detail);
    }
    if (!isJsonContentType(contentType)) {
      throw new Error(
        `Dashboard API ${request.path} returned ${contentType ?? "an unknown content type"} instead of JSON`,
      );
    }
    return (await response.json()) as T;
  }
}

let testTransport: DashboardTransport | undefined;

export function setDashboardTransportForTests(transport?: DashboardTransport): void {
  testTransport = transport;
}

export interface DashboardRuntimeTransport {
  protocol: string;
  bridge?: DashboardTransport;
}

export function resolveDashboardTransport(runtime: DashboardRuntimeTransport): DashboardTransport {
  if (runtime.bridge) return runtime.bridge;
  if (runtime.protocol === "app:") {
    throw new Error("Desktop preload bridge is unavailable");
  }
  return new HttpDashboardTransport();
}

export function dashboardTransport(): DashboardTransport {
  if (testTransport) return testTransport;
  const runtimeWindow = typeof window === "undefined" ? undefined : window;
  return resolveDashboardTransport({
    protocol: runtimeWindow?.location.protocol ?? "",
    ...(runtimeWindow?.lxe?.dashboard ? { bridge: runtimeWindow.lxe.dashboard } : {}),
  });
}

export async function fetchJson<T>(path: string): Promise<T> {
  return dashboardTransport().request<T>({ method: "GET", path });
}

export async function patchJson<T>(path: string, payload: JsonObject): Promise<T> {
  return dashboardTransport().request<T>({ method: "PATCH", path, body: payload });
}
