import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DASHBOARD_FONT_SIZE,
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
  });

  test("falls back safely when local storage is unavailable", () => {
    expect(initialDashboardFontSize({
      getItem: () => { throw new Error("storage disabled"); },
    })).toBe("standard");
  });
});
