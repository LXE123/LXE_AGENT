import { describe, expect, test } from "bun:test";

import {
  initialSidebarExpanded,
  SIDEBAR_EXPANDED_STORAGE_KEY,
  storeSidebarExpanded,
} from "../src/shared/sidebar-preference";

describe("sidebar preference", () => {
  test("defaults to expanded and restores a valid stored boolean", () => {
    expect(initialSidebarExpanded()).toBe(true);
    expect(initialSidebarExpanded({
      getItem: () => null,
      setItem: () => undefined,
    })).toBe(true);
    expect(initialSidebarExpanded({
      getItem: () => "true",
      setItem: () => undefined,
    })).toBe(true);
    expect(initialSidebarExpanded({
      getItem: () => "false",
      setItem: () => undefined,
    })).toBe(false);
    expect(initialSidebarExpanded({
      getItem: () => "invalid",
      setItem: () => undefined,
    })).toBe(true);
  });

  test("stores the fixed expanded state and tolerates unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    storeSidebarExpanded(false, storage);
    expect(values.get(SIDEBAR_EXPANDED_STORAGE_KEY)).toBe("false");
    storeSidebarExpanded(true, storage);
    expect(values.get(SIDEBAR_EXPANDED_STORAGE_KEY)).toBe("true");

    const unavailable = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(initialSidebarExpanded(unavailable)).toBe(true);
    expect(() => storeSidebarExpanded(true, unavailable)).not.toThrow();
  });
});
