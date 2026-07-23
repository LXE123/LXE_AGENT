import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bumpDesktopPatchVersion,
  formatDesktopVersion,
  parseDesktopVersion,
  selectDesktopVersion,
  updateDesktopPackageVersion,
} from "../scripts/select-desktop-version";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const answers = (...values: string[]) => {
  const pending = [...values];
  return async (): Promise<string> => {
    const value = pending.shift();
    if (value === undefined) throw new Error("Test did not provide enough prompt answers");
    return value;
  };
};

describe("desktop product version selection", () => {
  test("bumps only the patch component", () => {
    expect(formatDesktopVersion(bumpDesktopPatchVersion({ major: 0, minor: 1, patch: 0 })))
      .toBe("0.1.1");
    expect(formatDesktopVersion(bumpDesktopPatchVersion({ major: 0, minor: 1, patch: 9 })))
      .toBe("0.1.10");
    expect(formatDesktopVersion(bumpDesktopPatchVersion({ major: 0, minor: 9, patch: 9 })))
      .toBe("0.9.10");
  });

  test("uses the automatic patch version for Enter, y, and yes", async () => {
    const current = { major: 0, minor: 1, patch: 0 };
    for (const answer of ["", "y", "YES"]) {
      expect(formatDesktopVersion(await selectDesktopVersion(current, answers(answer))))
        .toBe("0.1.1");
    }
  });

  test("accepts the current or a higher manually selected version", async () => {
    const current = { major: 0, minor: 1, patch: 3 };
    expect(formatDesktopVersion(await selectDesktopVersion(current, answers("n", "0.1.3"))))
      .toBe("0.1.3");
    expect(formatDesktopVersion(await selectDesktopVersion(current, answers("no", "0.2.0"))))
      .toBe("0.2.0");
  });

  test("re-prompts for unknown choices, invalid versions, and downgrades", async () => {
    const notices: string[] = [];
    const selected = await selectDesktopVersion(
      { major: 0, minor: 2, patch: 0 },
      answers("maybe", "n", "v0.3.0", "0.1.9", "0.2.1"),
      (message) => notices.push(message),
    );

    expect(formatDesktopVersion(selected)).toBe("0.2.1");
    expect(notices).toEqual([
      "Please answer y or n.",
      "Invalid desktop version. Use x.y.z with non-negative integers.",
      "Desktop version cannot be lower than 0.2.0.",
    ]);
  });

  test("accepts only plain numeric x.y.z versions", () => {
    expect(parseDesktopVersion("0.2.0")).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(parseDesktopVersion("0.2.0-beta.1")).toBeUndefined();
    expect(parseDesktopVersion("v0.2.0")).toBeUndefined();
    expect(parseDesktopVersion("0.02.0")).toBeUndefined();
  });

  test("preserves the version command's real failure detail", () => {
    expect(() => updateDesktopPackageVersion(
      "/missing/desktop",
      { major: 0, minor: 2, patch: 0 },
      () => ({
        exitCode: 7,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("actual package update failure"),
      }),
    )).toThrow("actual package update failure");
  });

  test("writes the selected version through Bun package metadata", () => {
    const desktopRoot = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(desktopRoot);
    writeFileSync(
      join(desktopRoot, "package.json"),
      `${JSON.stringify({ name: "desktop-version-test", version: "0.1.0" }, null, 2)}\n`,
      "utf8",
    );

    updateDesktopPackageVersion(desktopRoot, { major: 0, minor: 2, patch: 0 });

    const manifest = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(manifest.version).toBe("0.2.0");
  });
});
