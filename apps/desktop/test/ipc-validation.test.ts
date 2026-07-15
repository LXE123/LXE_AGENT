import { describe, expect, test } from "bun:test";
import {
  validateDashboardRequest,
  validateSetupInput,
} from "../src/main/ipc-validation";

describe("desktop IPC validation", () => {
  test("allows the Dashboard API surface and normalizes its origin", () => {
    expect(validateDashboardRequest({
      method: "get",
      path: "/api/sessions?limit=6",
    })).toEqual({ method: "GET", path: "/api/sessions?limit=6" });
    expect(validateDashboardRequest({
      method: "PATCH",
      path: "/api/models/current/thinking",
      body: { level: "high" },
    })).toEqual({
      method: "PATCH",
      path: "/api/models/current/thinking",
      body: { level: "high" },
    });
  });

  test("rejects external origins, unlisted paths, and malformed bodies", () => {
    expect(() => validateDashboardRequest({
      method: "GET",
      path: "https://example.com/api/sessions",
    })).toThrow("origin is not allowed");
    expect(() => validateDashboardRequest({ method: "POST", path: "/api/sessions" }))
      .toThrow("method is not allowed");
    expect(() => validateDashboardRequest({ method: "GET", path: "/api/shell" }))
      .toThrow("path is not allowed");
    expect(() => validateDashboardRequest({ method: "PATCH", path: "/api/models/current", body: [] }))
      .toThrow("body must be an object");
  });

  test("accepts only bounded setup fields and supported providers", () => {
    expect(validateSetupInput({
      provider: "deepseek",
      api_key: " key ",
      workspace_root: " C:\\workspace ",
    })).toEqual({
      provider: "deepseek",
      api_key: "key",
      workspace_root: "C:\\workspace",
    });
    expect(() => validateSetupInput({ provider: "other", workspace_root: "C:\\workspace" }))
      .toThrow("Unsupported model provider");
    expect(() => validateSetupInput({ provider: "glm", workspace_root: "" }))
      .toThrow("Workspace is required");
  });
});
