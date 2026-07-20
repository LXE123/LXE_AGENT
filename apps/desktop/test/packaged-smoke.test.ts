import { describe, expect, test } from "bun:test";
import { packagedSmokeEnvironment } from "../scripts/smoke-packaged-app";

describe("packaged desktop smoke environment", () => {
  test("removes application configuration while preserving host process requirements", () => {
    const environment = packagedSmokeEnvironment({
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      LXE_DATA_ROOT: "C:\\state",
      LXE_DATA_SERVER_API_KEY: "cloud-secret",
      AGENT_LLM_PROVIDER: "glm",
      KIMI_CODE_API_KEY: "provider-secret",
      FEISHU_APP_SECRET: "feishu-secret",
      ZINIAO_PASSWORD: "browser-secret",
      MABANG_PASSWORD: "erp-secret",
      LOCAL_LOGS_ENABLED: "1",
    });

    expect(environment.PATH).toBe("C:\\Windows\\System32");
    expect(environment.SystemRoot).toBe("C:\\Windows");
    expect(environment.ELECTRON_ENABLE_LOGGING).toBe("1");
    expect(environment.LXE_MAINTENANCE_AUTH_ENABLED).toBe("0");
    for (const name of [
      "LXE_DATA_ROOT",
      "LXE_DATA_SERVER_API_KEY",
      "AGENT_LLM_PROVIDER",
      "KIMI_CODE_API_KEY",
      "FEISHU_APP_SECRET",
      "ZINIAO_PASSWORD",
      "MABANG_PASSWORD",
      "LOCAL_LOGS_ENABLED",
    ]) expect(environment[name]).toBeUndefined();
  });
});
