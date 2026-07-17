import { describe, expect, test } from "bun:test";

import { formatCompactNumber, formatNumber } from "../../src/shared/format";

describe("formatCompactNumber", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1K"],
    [32_768, "32.8K"],
    [256_000, "256K"],
    [384_000, "384K"],
    [999_949, "999.9K"],
    [999_950, "1M"],
    [1_000_000, "1M"],
    [1_250_000, "1.3M"]
  ])("formats %d as %s", (value, expected) => {
    expect(formatCompactNumber(value)).toBe(expected);
  });

  test("normalizes invalid and negative values", () => {
    expect(formatCompactNumber(Number.NaN)).toBe("0");
    expect(formatCompactNumber(-1)).toBe("0");
  });

  test("keeps an exact value available for accessible labels", () => {
    expect(formatNumber(1_000_000)).toBe("1,000,000");
    expect(formatNumber(32_768)).toBe("32,768");
  });
});
