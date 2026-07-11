import { describe, expect, test } from "bun:test";
import { loadFeishuConfig } from "./config";

describe("Feishu config", () => {
  test("preserves environment names, defaults, masking and Feishu/Lark domains", () => {
    const config = loadFeishuConfig({
      FEISHU_APP_ID: "cli_1234567890abcdef",
      FEISHU_APP_SECRET: "secret_1234567890",
      FEISHU_API_HOST: "https://open.larksuite.com/open-apis",
      FEISHU_WS_AUTO_RESTART_ENABLED: "false",
      FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS: "123",
    });
    expect(config.appId).toBe("cli_1234567890abcdef");
    expect(config.apiHost).toBe("https://open.larksuite.com/open-apis");
    expect(config.domain).toBe("lark");
    expect(config.autoRestartEnabled).toBe(false);
    expect(config.autoRestartIntervalMs).toBe(123_000);
    expect(config.health()).toEqual(expect.objectContaining({
      enabled: true,
      missing_required: [],
      app_id_masked: "cli_...cdef",
      api_host: "https://open.larksuite.com/open-apis",
    }));
  });

  test("reports and rejects missing credentials without exposing secrets", () => {
    const config = loadFeishuConfig({ FEISHU_APP_ID: "cli_short" });
    expect(config.health()).toEqual(expect.objectContaining({
      enabled: false,
      missing_required: ["FEISHU_APP_SECRET"],
    }));
    expect(JSON.stringify(config.health())).not.toContain("secret_");
    expect(() => config.validate()).toThrow("FEISHU_APP_SECRET");
  });
});
