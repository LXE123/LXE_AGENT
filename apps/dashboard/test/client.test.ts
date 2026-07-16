import { afterEach, describe, expect, test } from "bun:test";
import type { DashboardTransport, DashboardTransportRequest } from "@lxe/desktop-protocol";
import {
  fetchJson,
  HttpDashboardTransport,
  patchJson,
  resolveDashboardTransport,
  setDashboardTransportForTests,
} from "../src/api/client";

afterEach(() => setDashboardTransportForTests(undefined));

describe("Dashboard transport", () => {
  test("routes view helpers through the configured transport", async () => {
    const requests: DashboardTransportRequest[] = [];
    const transport: DashboardTransport = {
      request: async <T>(request: DashboardTransportRequest): Promise<T> => {
        requests.push(request);
        return { ok: true } as T;
      },
    };
    setDashboardTransportForTests(transport);

    await fetchJson("/api/sessions?limit=6");
    await patchJson("/api/models/current", { provider: "glm", model: "glm-4.7" });

    expect(requests).toEqual([
      { method: "GET", path: "/api/sessions?limit=6" },
      {
        method: "PATCH",
        path: "/api/models/current",
        body: { provider: "glm", model: "glm-4.7" },
      },
    ]);
  });

  test("requires the preload bridge for the packaged app protocol", () => {
    expect(() => resolveDashboardTransport({ protocol: "app:" }))
      .toThrow("Desktop preload bridge is unavailable");
  });

  test("keeps HTTP transport for browser deployments", () => {
    expect(resolveDashboardTransport({ protocol: "https:" }))
      .toBeInstanceOf(HttpDashboardTransport);
  });

  test("uses the injected desktop bridge before considering HTTP", () => {
    const bridge: DashboardTransport = {
      request: async <T>(): Promise<T> => ({ ok: true }) as T,
    };
    expect(resolveDashboardTransport({ protocol: "app:", bridge })).toBe(bridge);
  });

  test("rejects successful HTML responses before JSON parsing", async () => {
    const transport = new HttpDashboardTransport(async () => new Response(
      "<!doctype html><title>Dashboard</title>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    ));

    await expect(transport.request({ method: "GET", path: "/api/models" }))
      .rejects.toThrow("returned text/html; charset=utf-8 instead of JSON");
  });

  test("parses JSON responses in browser deployments", async () => {
    const transport = new HttpDashboardTransport(async () => Response.json({ models: ["glm-4.7"] }));

    await expect(transport.request({ method: "GET", path: "/api/models" }))
      .resolves.toEqual({ models: ["glm-4.7"] });
  });

  test("preserves JSON error details from the HTTP API", async () => {
    const transport = new HttpDashboardTransport(async () => Response.json(
      { detail: "model provider is unavailable" },
      { status: 503 },
    ));

    await expect(transport.request({ method: "GET", path: "/api/models" }))
      .rejects.toThrow("model provider is unavailable");
  });
});
