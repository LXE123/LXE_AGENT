import { describe, expect, test } from "bun:test";
import {
  validateCloudActivationInput,
  validateCloudDestination,
  validateDashboardRpcCall,
  validateEnrollmentId,
  validateLocalModelCredentialInput,
  validateModelProvider,
  validateSetupInput,
  validateSyntheticPerformerId,
  validateSyntheticPerformerSourceKind,
  validateSyntheticPerformerTaskInput,
} from "../src/main/ipc-validation";

describe("desktop IPC validation", () => {
  test("accepts only the fixed cloud destinations", () => {
    expect(validateCloudDestination("agent_dashboard")).toBe("agent_dashboard");
    expect(validateCloudDestination("erp_dashboard")).toBe("erp_dashboard");
    expect(validateCloudDestination("admin_dashboard")).toBe("admin_dashboard");
    expect(() => validateCloudDestination("https://attacker.example")).toThrow("unsupported");
    expect(() => validateCloudDestination("docs")).toThrow("unsupported");
    expect(() => validateCloudDestination({ destination: "erp_dashboard" })).toThrow("unsupported");
  });

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
  test("accepts only opaque bounded enrollment ids", () => {
    expect(validateEnrollmentId(" 39b01a67-1835-48d4-b83f-74e9400c203b "))
      .toBe("39b01a67-1835-48d4-b83f-74e9400c203b");
    expect(() => validateEnrollmentId("../desktop.json")).toThrow("invalid");
    expect(() => validateEnrollmentId(42)).toThrow("must be a string");
    expect(() => validateEnrollmentId("a".repeat(129))).toThrow("too long");
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

  test("accepts only bounded setup fields", () => {
    expect(validateSetupInput({
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
    expect(() => validateSetupInput({ workspace_root: "" }))
      .toThrow("Workspace is required");
    expect(() => validateSetupInput({
      workspace_root: "C:\\workspace",
      ziniao: { action: "save", app_version: "v7" },
    })).toThrow("Ziniao app version is unsupported");
    expect(() => validateSetupInput({
      workspace_root: "C:\\workspace",
      logging: { profile: "verbose", retention_days: 7 },
    })).toThrow("Log profile is unsupported");
  });

  test("validates local model credentials independently from setup", () => {
    expect(validateModelProvider("glm")).toBe("glm");
    expect(() => validateModelProvider("other")).toThrow("Unsupported model provider");
    expect(validateLocalModelCredentialInput({ provider: "deepseek", api_key: " key " }))
      .toEqual({ provider: "deepseek", api_key: "key" });
    expect(() => validateLocalModelCredentialInput({ provider: "deepseek", api_key: "" }))
      .toThrow("required");
  });
});
