import { describe, expect, test } from "bun:test";
import { dataServerRuntimePolicy } from "../src/main/data-server-policy";

describe("desktop data server policy", () => {
  test("allows local fallback for source development and Preview", () => {
    expect(dataServerRuntimePolicy(false)).toEqual({
      LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: "1",
    });
  });

  test("forces local fallback off for packaged builds", () => {
    const configured = { LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: "1" };
    const environment = { ...configured, ...dataServerRuntimePolicy(true) };

    expect(environment.LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED).toBe("0");
  });
});
