import { describe, expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import { runtimeConfigWarnings } from "../../src/bootstrap/runtime-config";

const projectRoot = repositoryRoot(import.meta.dir);

describe("runtimeConfigWarnings", () => {
  test("reports missing Bun-owned Feishu and LLM production configuration", () => {
    const warnings = runtimeConfigWarnings(projectRoot, {});
    expect(warnings.some((message) => message.includes("Feishu runtime config missing"))).toBe(true);
    expect(warnings.some((message) => message.includes("LLM runtime config invalid"))).toBe(true);
  });

  test("accepts a configured Bun production runtime without exposing secrets", () => {
    const warnings = runtimeConfigWarnings(projectRoot, {
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "top-secret",
      AGENT_LLM_PROVIDER: "kimi_coding",
      KIMI_CODE_API_KEY: "llm-secret",
    });
    expect(warnings).toEqual([]);
  });
});
