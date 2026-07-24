import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadFeishuConfig } from "../../../src/channels/feishu/config";

describe("Feishu config", () => {
  test("preserves environment names, defaults, masking and Feishu/Lark domains", () => {
    const config = loadFeishuConfig({
      FEISHU_APP_ID: "cli_1234567890abcdef",
      FEISHU_APP_SECRET: "secret_1234567890",
      FEISHU_API_HOST: "https://open.larksuite.com/open-apis",
      LXE_FEISHU_GATEWAY_ENABLED: "false",
      LXE_FEISHU_WS_AUTO_RESTART_ENABLED: "false",
      LXE_FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS: "123",
      FEISHU_RAW_EVENT_DUMP_DIR: "/tmp/ignored-feishu-events",
    });
    expect(config.appId).toBe("cli_1234567890abcdef");
    expect(config.apiHost).toBe("https://open.larksuite.com/open-apis");
    expect(config.domain).toBe("lark");
    expect(config.gatewayEnabled).toBe(false);
    expect(config.autoRestartEnabled).toBe(true);
    expect(config.autoRestartIntervalMs).toBe(5_400_000);
    expect(config.rawEventDumpEnabled).toBe(false);
    expect(config.rawEventDumpDir).toBe(resolve("var", "logs", "feishu_raw_events"));
    expect(config.cardDisplay).toEqual({
      toolUseMode: "on",
      showFullPaths: false,
      footer: { status: false, elapsed: false, tokens: false, cache: false, context: false, model: false },
    });
    expect(config.health()).toEqual(expect.objectContaining({
      enabled: true,
      missing_required: [],
      app_id_masked: "cli_...cdef",
      api_host: "https://open.larksuite.com/open-apis",
    }));
  });

  test("keeps the gateway compatibility key but ignores retired restart tuning", () => {
    const config = loadFeishuConfig({
      FEISHU_GATEWAY_ENABLED: "false",
      FEISHU_WS_AUTO_RESTART_ENABLED: "false",
      FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS: "123",
    });
    expect(config.gatewayEnabled).toBe(false);
    expect(config.autoRestartEnabled).toBe(true);
    expect(config.autoRestartIntervalMs).toBe(5_400_000);
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

  test("loads tool detail and footer display switches", () => {
    const config = loadFeishuConfig({
      FEISHU_TOOL_USE_MODE: "full",
      FEISHU_TOOL_USE_SHOW_FULL_PATHS: "1",
      FEISHU_CARD_FOOTER_STATUS: "true",
      FEISHU_CARD_FOOTER_MODEL: "yes",
    });
    expect(config.cardDisplay).toEqual({
      toolUseMode: "full",
      showFullPaths: true,
      footer: { status: true, elapsed: false, tokens: false, cache: false, context: false, model: true },
    });
    expect(loadFeishuConfig({ FEISHU_TOOL_USE_MODE: "invalid" }).cardDisplay.toolUseMode).toBe("on");
    expect(loadFeishuConfig({ LOCAL_LOGS_ENABLED: "1" }).rawEventDumpEnabled).toBe(true);
    expect(loadFeishuConfig({ LOCAL_LOGS_ENABLED: "1", FEISHU_RAW_EVENT_DUMP_ENABLED: "0" }).rawEventDumpEnabled).toBe(false);
    expect(loadFeishuConfig({ LXE_DATA_ROOT: "/tmp/lxe-data" }).rawEventDumpDir)
      .toBe(resolve("/tmp/lxe-data", "logs", "feishu_raw_events"));
  });
});
