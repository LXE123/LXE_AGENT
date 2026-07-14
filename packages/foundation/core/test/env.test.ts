import { describe, expect, test } from "bun:test";
import { envFlag, envInteger, envText } from "../src/env";

describe("core environment parsing", () => {
  test("parses text, flags, and bounded integers without truthy surprises", () => {
    const env = {
      TEXT: " value ",
      YES: "on",
      NO: "false",
      BAD: "maybe",
      PORT: "70000",
    };
    expect(envText(env, "TEXT", "fallback")).toBe("value");
    expect(envText(env, "MISSING", " fallback ")).toBe("fallback");
    expect(envFlag(env, "YES", false)).toBe(true);
    expect(envFlag(env, "NO", true)).toBe(false);
    expect(envFlag(env, "BAD", true)).toBe(true);
    expect(envInteger(env, "PORT", 8765, { min: 0, max: 65535 })).toBe(8765);
  });
});
