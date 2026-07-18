import { describe, expect, test } from "bun:test";
import { loadAgentFeishuConfig } from "../src/feishu-runtime-config";

describe("Agent Feishu runtime config", () => {
  test("reads only inherited credentials and Agent tool display settings", () => {
    const config = loadAgentFeishuConfig({
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_API_HOST: "https://open.larksuite.com/open-apis",
      FEISHU_TOOL_USE_MODE: "full",
      FEISHU_TOOL_USE_SHOW_FULL_PATHS: "true",
    });

    expect(config).toMatchObject({
      appId: "cli-test",
      appSecret: "secret",
      apiHost: "https://open.larksuite.com/open-apis",
      domain: "lark",
      cardDisplay: { toolUseMode: "full", showFullPaths: true },
    });
    expect(config.missingRequired()).toEqual([]);
  });

  test("uses Feishu defaults and reports missing credentials", () => {
    const config = loadAgentFeishuConfig({});

    expect(config.apiHost).toBe("https://open.feishu.cn/open-apis");
    expect(config.domain).toBe("feishu");
    expect(config.cardDisplay).toEqual({ toolUseMode: "on", showFullPaths: false });
    expect(config.missingRequired()).toEqual(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
  });

  test("passes a custom API origin to the official SDK domain option", () => {
    const config = loadAgentFeishuConfig({
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_API_HOST: "https://proxy.example.test/open-apis",
      FEISHU_TOOL_USE_MODE: "invalid",
    });

    expect(config.domain).toBe("https://proxy.example.test");
    expect(config.cardDisplay.toolUseMode).toBe("on");
  });
});
