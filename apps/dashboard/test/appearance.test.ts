import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_DASHBOARD_FONT_SIZE,
  FONT_SIZE_STORAGE_KEY,
  initialDashboardFontSize,
  isDashboardFontSize,
} from "../src/shared/appearance";

describe("Dashboard appearance persistence", () => {
  test("restores only supported font-size choices", () => {
    const storage = (value: string | null) => ({ getItem: () => value });

    expect(initialDashboardFontSize(storage("small"))).toBe("small");
    expect(initialDashboardFontSize(storage("large"))).toBe("large");
    expect(initialDashboardFontSize(storage("125%"))).toBe(DEFAULT_DASHBOARD_FONT_SIZE);
    expect(initialDashboardFontSize(storage(null))).toBe("standard");
    expect(isDashboardFontSize("standard")).toBe(true);
    expect(isDashboardFontSize("medium")).toBe(false);
    expect(FONT_SIZE_STORAGE_KEY).toBe("lxe.window.main.font-size.v1");
  });

  test("falls back safely when local storage is unavailable", () => {
    expect(initialDashboardFontSize({
      getItem: () => { throw new Error("storage disabled"); },
    })).toBe("standard");
  });

  test("keeps the standard layout unchanged while making text respond to the root size", () => {
    const styles = readFileSync(resolve(import.meta.dir, "..", "src", "styles.css"), "utf8");
    const absoluteRootSizes = styles.match(/font-size:\s*[^;]*px/g) ?? [];

    expect(absoluteRootSizes).toEqual([
      "font-size: 16px",
      "font-size: 15px",
      "font-size: 18px",
    ]);
    expect(styles).toContain("font-size: 0.75rem;");
    expect(styles).toContain(':root[data-font-size="small"]');
    expect(styles).toContain(':root[data-font-size="large"]');
  });
});
