import { describe, expect, test } from "bun:test";
import parity from "./fixtures/main-production-parity.json";

describe("frozen main production parity", () => {
  test("records the non-negotiable migration defaults", () => {
    expect(parity.runtime).toEqual({
      max_steps: 50,
      max_step_reply: "本轮已达到最大步骤，请发送下一条消息继续。",
      provider_attempts: 3,
      overflow_retries: 1,
    });
    expect(parity.mcp).toEqual({
      startup_timeout_seconds: 10,
      tool_timeout_seconds: 60,
      default_exposure: "deferred",
    });
    expect(parity.coding.protected_root_directories).toContain("user_session_db");
    expect(parity.storage.strip_persisted_base64_images).toBe(true);
  });
});
