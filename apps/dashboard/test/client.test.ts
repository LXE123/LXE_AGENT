import { afterEach, describe, expect, test } from "bun:test";
import type { DashboardTransport, DashboardTransportRequest } from "@lxe/desktop-protocol";
import {
  fetchJson,
  patchJson,
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
});
