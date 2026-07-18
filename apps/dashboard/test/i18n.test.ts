import { describe, expect, test } from "bun:test";

import { initialLanguage, LANGUAGE_STORAGE_KEY } from "../src/shared/i18n";

describe("Dashboard language persistence", () => {
  test("migrates the legacy language key into the window-scoped key", () => {
    const values = new Map<string, string>([["agent-dashboard-language", "en"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(initialLanguage(storage)).toBe("en");
    expect(LANGUAGE_STORAGE_KEY).toBe("lxe.window.main.language.v1");
    expect(values.get(LANGUAGE_STORAGE_KEY)).toBe("en");
  });
});
