import { describe, expect, test } from "bun:test";
import {
  validateCloudActivationInput,
  validateConfigImportId,
  validateDashboardRpcCall,
  validateSetupInput,
  validateSyntheticPerformerId,
  validateSyntheticPerformerSourceKind,
  validateSyntheticPerformerTaskInput,
} from "../src/main/ipc-validation";

describe("desktop IPC validation", () => {
  test("validates the synthetic performer task boundary", () => {
    expect(validateSyntheticPerformerSourceKind("files")).toBe("files");
    expect(validateSyntheticPerformerSourceKind("folder")).toBe("folder");
    expect(() => validateSyntheticPerformerSourceKind("path")).toThrow("unsupported");
    expect(validateSyntheticPerformerId("task-123")).toBe("task-123");
    expect(() => validateSyntheticPerformerId("../task")).toThrow("invalid");
    expect(validateSyntheticPerformerTaskInput({
      action: "scan",
      selection_id: "selection-1",
      recursive: false,
    })).toEqual({ action: "scan", selection_id: "selection-1", recursive: false });
    expect(validateSyntheticPerformerTaskInput({
      action: "apply",
      selection_id: "selection-1",
      output_id: "output-1",
      recursive: true,
    })).toEqual({
      action: "apply",
      selection_id: "selection-1",
      output_id: "output-1",
      recursive: true,
    });
    expect(() => validateSyntheticPerformerTaskInput({
      action: "apply",
      selection_id: "selection-1",
      recursive: true,
    })).toThrow("identifier");
  });
  test("accepts only opaque enrollment ids and bounded passwords", () => {
    expect(validateCloudActivationInput({
      enrollment_id: "enroll-123",
      password: " ABCD-EFGH-JKLM-NPQR ",
    })).toEqual({ enrollment_id: "enroll-123", password: "ABCD-EFGH-JKLM-NPQR" });
    expect(() => validateCloudActivationInput({ enrollment_id: "../bad", password: "A".repeat(20) }))
      .toThrow("invalid");
    expect(() => validateCloudActivationInput({ enrollment_id: "valid", password: "short" }))
      .toThrow("invalid");
  });
  test("accepts only opaque bounded configuration import ids", () => {
    expect(validateConfigImportId(" 39b01a67-1835-48d4-b83f-74e9400c203b "))
      .toBe("39b01a67-1835-48d4-b83f-74e9400c203b");
    expect(() => validateConfigImportId("../desktop.json")).toThrow("invalid");
    expect(() => validateConfigImportId(42)).toThrow("must be a string");
    expect(() => validateConfigImportId("a".repeat(129))).toThrow("too long");
  });

  test("allows and normalizes the typed Dashboard RPC surface", () => {
    expect(validateDashboardRpcCall({
      operation: "sessions.list",
      input: { query: " order ", limit: 6 },
    })).toEqual({
      operation: "sessions.list",
      input: { query: "order", limit: 6, offset: 0 },
    });
    expect(validateDashboardRpcCall({
      operation: "models.thinking.update",
      input: { level: "high" },
    })).toEqual({ operation: "models.thinking.update", input: { level: "high" } });
    expect(validateDashboardRpcCall({
      operation: "sessions.workspace.reload",
      input: { session_id: "session-one" },
    })).toEqual({ operation: "sessions.workspace.reload", input: { session_id: "session-one" } });
  });

  test("rejects unknown operations and malformed inputs", () => {
    expect(() => validateDashboardRpcCall({ operation: "sessions.search", input: {} }))
      .toThrow("unsupported Dashboard RPC operation");
    expect(() => validateDashboardRpcCall({ operation: "models.update", input: [] }))
      .toThrow("input must be an object");
    expect(() => validateDashboardRpcCall({ operation: "models.update", input: { provider: 42 } }))
      .toThrow("provider must be a string");
    expect(() => validateDashboardRpcCall({ operation: "connectors.update", input: { id: "feishu" } }))
      .toThrow("enabled must be a boolean");
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
