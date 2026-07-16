import { describe, expect, test } from "bun:test";
import {
  validateConfigImportId,
  validateDashboardRequest,
  validateSetupInput,
} from "../src/main/ipc-validation";

describe("desktop IPC validation", () => {
  test("accepts only opaque bounded configuration import ids", () => {
    expect(validateConfigImportId(" 39b01a67-1835-48d4-b83f-74e9400c203b "))
      .toBe("39b01a67-1835-48d4-b83f-74e9400c203b");
    expect(() => validateConfigImportId("../desktop.json")).toThrow("invalid");
    expect(() => validateConfigImportId(42)).toThrow("must be a string");
    expect(() => validateConfigImportId("a".repeat(129))).toThrow("too long");
  });

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
      ziniao: {
        action: "save",
        company: " LXE ",
        username: " user ",
        password: " password ",
        app_version: "v6",
        app_path: " C:\\Ziniao.exe ",
        webdriver_path: " C:\\drivers ",
      },
      logging: { profile: "standard", retention_days: 7 },
    })).toEqual({
      provider: "deepseek",
      api_key: "key",
      workspace_root: "C:\\workspace",
      ziniao: {
        action: "save",
        company: "LXE",
        username: "user",
        password: "password",
        app_version: "v6",
        app_path: "C:\\Ziniao.exe",
        webdriver_path: "C:\\drivers",
      },
      logging: { profile: "standard", retention_days: 7 },
    });
    expect(() => validateSetupInput({ provider: "other", workspace_root: "C:\\workspace" }))
      .toThrow("Unsupported model provider");
    expect(() => validateSetupInput({ provider: "glm", workspace_root: "" }))
      .toThrow("Workspace is required");
    expect(() => validateSetupInput({
      provider: "glm",
      workspace_root: "C:\\workspace",
      ziniao: { action: "save", app_version: "v7" },
    })).toThrow("Ziniao app version is unsupported");
    expect(() => validateSetupInput({
      provider: "glm",
      workspace_root: "C:\\workspace",
      logging: { profile: "verbose", retention_days: 7 },
    })).toThrow("Log profile is unsupported");
  });
});
