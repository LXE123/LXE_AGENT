import { describe, expect, test } from "bun:test";

import { initialLanguage, LANGUAGE_STORAGE_KEY, UI_TEXT } from "../src/shared/i18n";

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

  test("formats completed process durations without inventing missing precision", () => {
    expect(UI_TEXT.zh.conversation.elapsedDuration(200)).toBe("不足1秒");
    expect(UI_TEXT.zh.conversation.elapsedDuration(80_000)).toBe("1分20秒");
    expect(UI_TEXT.en.conversation.elapsedDuration(3_661_000)).toBe("1h 1m 1s");
  });
});
