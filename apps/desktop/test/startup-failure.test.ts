import { describe, expect, test } from "bun:test";
import { reportDesktopStartupFailure } from "../src/main/startup-failure";

describe("desktop startup failure reporting", () => {
  test("preserves the actual missing runtime path", () => {
    const stderr: string[] = [];
    const dialogs: Array<[string, string]> = [];
    const detail = reportDesktopStartupFailure(
      new Error("Desktop resource file is missing: runtime/python/python.exe"),
      {
        writeStderr: (message) => stderr.push(message),
        showError: (title, message) => dialogs.push([title, message]),
      },
    );

    expect(detail).toBe("Desktop resource file is missing: runtime/python/python.exe");
    expect(stderr).toEqual([
      "LXE Agent startup failed: Desktop resource file is missing: runtime/python/python.exe\n",
    ]);
    expect(dialogs).toEqual([[
      "LXE Agent 无法启动",
      "Desktop resource file is missing: runtime/python/python.exe",
    ]]);
  });
});
