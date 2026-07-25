import { describe, expect, test } from "bun:test";

import { formatCompactNumber, formatNumber, groupSkillsByType, skillTypeLabel } from "../../src/shared/format";
import { UI_TEXT } from "../../src/shared/i18n";

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

describe("Amazon Operations skill group", () => {
  test("uses the English module name in both locales", () => {
    expect(skillTypeLabel("amazon_operations", UI_TEXT.zh)).toBe("Amazon Operations");
    expect(skillTypeLabel("amazon_operations", UI_TEXT.en)).toBe("Amazon Operations");
  });

  test("sorts the module after the existing Amazon groups", () => {
    const groups = groupSkillsByType([
      { name: "operations", type: "amazon_operations" },
      { name: "replenish", type: "amazon_replenish" },
      { name: "fba", type: "amazon_fba" },
      { name: "default", type: "default" },
    ] as never, UI_TEXT.zh);

    expect(groups.map((group) => group.type)).toEqual([
      "default",
      "amazon_fba",
      "amazon_replenish",
      "amazon_operations",
    ]);
  });
});
