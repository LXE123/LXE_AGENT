import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging";

describe("structured logger", () => {
  test("emits one JSON record with stable context and a serialized error", () => {
    const lines: string[] = [];
    const logger = createLogger("gateway", {
      write: (line) => lines.push(line),
      now: () => "2026-07-11T00:00:00.000Z",
    }).child({ boot_id: "boot-1" });
    logger.error("startup failed", { error: new Error("boom"), secret: undefined });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(expect.objectContaining({
      timestamp: "2026-07-11T00:00:00.000Z",
      level: "error",
      logger: "gateway",
      message: "startup failed",
      boot_id: "boot-1",
      error: expect.objectContaining({ name: "Error", message: "boom" }),
    }));
  });
});
