import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadProjectEnv } from "@lxe/gateway/desktop";
import {
  resolveDataServerRuntimeEnvironment,
  resolvePreviewDataServerTarget,
  withoutDataServerEnvironment,
} from "../src/main/data-server-policy";

describe("desktop data server policy", () => {
  test("resolves a complete Preview target without exposing unrelated environment values", () => {
    expect(resolvePreviewDataServerTarget({
      LXE_DATA_SERVER_ENABLED: "yes",
      LXE_DATA_SERVER_URL: " http://10.88.0.1:8000/ ",
      LXE_DATA_SERVER_API_KEY: " device-secret ",
      LXE_ERP_API_KEY: "unrelated-secret",
    })).toEqual({
      dataServerUrl: "http://10.88.0.1:8000",
      apiToken: "device-secret",
    });
  });

  test("does not enable Preview probing with disabled or incomplete source settings", () => {
    expect(resolvePreviewDataServerTarget({
      LXE_DATA_SERVER_ENABLED: "0",
      LXE_DATA_SERVER_URL: "http://10.88.0.1:8000",
      LXE_DATA_SERVER_API_KEY: "device-secret",
    })).toBeUndefined();
    expect(resolvePreviewDataServerTarget({
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_URL: "http://10.88.0.1:8000",
    })).toBeUndefined();
    expect(resolvePreviewDataServerTarget({
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_API_KEY: "device-secret",
    })).toBeUndefined();
  });

  test("uses the repository environment for source development and Preview", () => {
    const files: Record<string, string> = {
      [join("/worktree", ".env")]: "LXE_DATA_SERVER_API_KEY=source-secret\nLXE_ERP_API_KEY=source-erp-secret\n",
      [join("/worktree", ".env.local")]: [
        "LXE_DATA_SERVER_ENABLED=1",
        "LXE_DATA_SERVER_URL=http://127.0.0.1:18000",
        "LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED=1",
        "LXE_DATA_SERVER_FALLBACK_URL=http://127.0.0.1:18001",
        "LXE_DATA_SERVER_FALLBACK_API_KEY=fallback-secret",
      ].join("\n"),
      [join("/worktree", "config", "runtime.env")]: [
        "LXE_DATA_SERVER_ENABLED=0",
      ].join("\n"),
    };
    const sourceEnvironment = loadProjectEnv({
      projectRoot: "/worktree",
      initial: {},
      readFile: (path) => files[path],
    });

    const environment = resolveDataServerRuntimeEnvironment({
      packaged: false,
      sourceEnvironment,
      managedEnvironment: {
        LXE_DATA_SERVER_ENABLED: "0",
        LXE_DATA_SERVER_URL: "",
        LXE_DATA_SERVER_API_KEY: "managed-secret",
        LXE_ERP_API_KEY: "managed-erp-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "0",
      },
      machineIdentityPath: "/worktree/var/db/machine_identity.json",
    });

    expect(environment).toMatchObject({
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_URL: "http://127.0.0.1:18000",
      LXE_DATA_SERVER_API_KEY: "source-secret",
      LXE_ERP_API_KEY: "source-erp-secret",
      LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: "1",
      LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
      LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:18001",
      LXE_DATA_SERVER_FALLBACK_API_KEY: "fallback-secret",
      LXE_DATA_SERVER_MACHINE_ID_PATH: "/worktree/var/db/machine_identity.json",
    });
  });

  test("uses only managed data server values for packaged builds", () => {
    const environment = resolveDataServerRuntimeEnvironment({
      packaged: true,
      sourceEnvironment: {
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "http://source.example",
        LXE_DATA_SERVER_API_KEY: "source-secret",
        LXE_ERP_API_KEY: "source-erp-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: "1",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "fallback-secret",
      },
      managedEnvironment: {
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "http://10.88.0.1:8000",
        LXE_DATA_SERVER_API_KEY: "managed-secret",
        LXE_ERP_API_KEY: "managed-erp-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "0",
      },
      machineIdentityPath: "C:\\LXE Agent\\var\\db\\machine_identity.json",
    });

    expect(environment).toEqual({
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_URL: "http://10.88.0.1:8000",
      LXE_DATA_SERVER_API_KEY: "managed-secret",
      LXE_ERP_API_KEY: "managed-erp-secret",
      LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "0",
      LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: "0",
      LXE_DATA_SERVER_MACHINE_ID_PATH: "C:\\LXE Agent\\var\\db\\machine_identity.json",
    });
    expect(JSON.stringify(environment)).not.toContain("source-secret");
    expect(JSON.stringify(environment)).not.toContain("source-erp-secret");
    expect(JSON.stringify(environment)).not.toContain("fallback-secret");
  });

  test("removes every inherited data server key before mode-specific values are applied", () => {
    expect(withoutDataServerEnvironment({
      AGENT_LLM_PROVIDER: "kimi_coding",
      LXE_DATA_SERVER_ENABLED: "1",
      LXE_DATA_SERVER_FUTURE_SECRET: "must-not-pass-through",
      LXE_DATA_SERVER_MACHINE_ID_PATH: "/untrusted/machine.json",
      LXE_ERP_API_KEY: "untrusted-erp-secret",
    })).toEqual({ AGENT_LLM_PROVIDER: "kimi_coding" });
  });

  test("always replaces an attempted machine identity override with the canonical path", () => {
    expect(resolveDataServerRuntimeEnvironment({
      packaged: false,
      sourceEnvironment: { LXE_DATA_SERVER_MACHINE_ID_PATH: "/untrusted/machine.json" },
      managedEnvironment: {},
      machineIdentityPath: "/repo/var/db/machine_identity.json",
    }).LXE_DATA_SERVER_MACHINE_ID_PATH).toBe("/repo/var/db/machine_identity.json");
  });
});
