import { describe, expect, test } from "bun:test";
import { reportDesktopStartupFailure } from "../src/main/startup-failure";

describe("desktop startup failure reporting", () => {
  test("preserves the actual component startup error", () => {
    const stderr: string[] = [];
    const dialogs: Array<[string, string]> = [];
    const detail = reportDesktopStartupFailure(
      new Error("spawn D:\\LXE Agent\\resources\\runtime\\agent-cli\\agent-cli.exe ENOENT"),
      {
        writeStderr: (message) => stderr.push(message),
        showError: (title, message) => dialogs.push([title, message]),
      },
    );

    expect(detail).toBe("spawn D:\\LXE Agent\\resources\\runtime\\agent-cli\\agent-cli.exe ENOENT");
    expect(stderr).toEqual([
      "LXE Agent startup failed: spawn D:\\LXE Agent\\resources\\runtime\\agent-cli\\agent-cli.exe ENOENT\n",
    ]);
    expect(dialogs).toEqual([[
      "LXE Agent 无法启动",
      "spawn D:\\LXE Agent\\resources\\runtime\\agent-cli\\agent-cli.exe ENOENT",
    ]]);
  });
});
