import { describe, expect, test } from "bun:test";
import { isDashboardTheme, resolveTheme } from "../../src/shared/appearance";

describe("theme preference", () => {
  test("system follows the OS and an explicit choice overrides it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(isDashboardTheme("dark")).toBe(true);
    expect(isDashboardTheme("sepia")).toBe(false);
    expect(isDashboardTheme(null)).toBe(false);
  });
});
