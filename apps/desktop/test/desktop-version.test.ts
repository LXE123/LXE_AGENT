import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyDesktopProductVersion } from "../../../scripts/desktop-builder-version";

import {
  bumpDesktopPatchVersion,
  commitDesktopVersionSelection,
  formatDesktopVersion,
  parseDesktopVersion,
  prepareDesktopVersionSelection,
  readDesktopVersionState,
  selectDesktopVersion,
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

  test("initializes missing local state at 0.1.0", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(root);
    const statePath = join(root, "config", "desktop-version.local.json");
    const selectionPath = join(root, "build", "desktop-version-selection.json");

    const selected = await prepareDesktopVersionSelection(
      "current",
      statePath,
      selectionPath,
      answers(),
    );

    expect(formatDesktopVersion(selected)).toBe("0.1.0");
    expect(readDesktopVersionState(statePath)).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      schema_version: 1,
      last_successful_version: "0.1.0",
    });
  });

  test("stages an NSIS version without advancing successful local state", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(root);
    const statePath = join(root, "config", "desktop-version.local.json");
    const selectionPath = join(root, "build", "desktop-version-selection.json");

    const selected = await prepareDesktopVersionSelection(
      "select",
      statePath,
      selectionPath,
      answers(""),
    );

    expect(formatDesktopVersion(selected)).toBe("0.1.1");
    expect(readDesktopVersionState(statePath)).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(JSON.parse(readFileSync(selectionPath, "utf8"))).toEqual({
      schema_version: 1,
      selected_version: "0.1.1",
    });
  });

  test("commits the selected version only after a successful build", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(root);
    const statePath = join(root, "config", "desktop-version.local.json");
    const selectionPath = join(root, "build", "desktop-version-selection.json");

    await prepareDesktopVersionSelection("select", statePath, selectionPath, answers(""));
    commitDesktopVersionSelection(statePath, selectionPath);

    expect(readDesktopVersionState(statePath)).toEqual({ major: 0, minor: 1, patch: 1 });
  });

  test("uses the current version for unpacked builds without incrementing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(root);
    const statePath = join(root, "config", "desktop-version.local.json");
    const selectionPath = join(root, "build", "desktop-version-selection.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({ schema_version: 1, last_successful_version: "0.4.7" }, null, 2)}\n`,
      "utf8",
    );

    const selected = await prepareDesktopVersionSelection(
      "current",
      statePath,
      selectionPath,
      answers(),
    );

    expect(formatDesktopVersion(selected)).toBe("0.4.7");
    expect(readDesktopVersionState(statePath)).toEqual({ major: 0, minor: 4, patch: 7 });
  });

  test("preserves actual parse failures from an invalid local state file", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(root);
    const statePath = join(root, "desktop-version.local.json");
    writeFileSync(statePath, "{ definitely not json", "utf8");

    expect(() => readDesktopVersionState(statePath)).toThrow(/desktop version state.*JSON/iu);
  });

  test("never modifies the tracked desktop package manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-version-"));
    temporaryRoots.push(root);
    const statePath = join(root, "config", "desktop-version.local.json");
    const selectionPath = join(root, "build", "desktop-version-selection.json");
    const packagePath = join(import.meta.dir, "..", "package.json");
    const before = readFileSync(packagePath, "utf8");

    await prepareDesktopVersionSelection("select", statePath, selectionPath, answers(""));
    commitDesktopVersionSelection(statePath, selectionPath);

    expect(readFileSync(packagePath, "utf8")).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ version: "0.1.0" });
    expect(existsSync(statePath)).toBeTrue();
  });

  test("injects the local version into generated electron-builder metadata", () => {
    const builderConfig = { extraMetadata: { release_channel: "local" } };

    applyDesktopProductVersion(builderConfig, "0.7.3");

    expect(builderConfig.extraMetadata).toEqual({
      release_channel: "local",
      version: "0.7.3",
    });
    expect(() => applyDesktopProductVersion({}, undefined)).toThrow("<missing>");
    expect(() => applyDesktopProductVersion({}, "v0.7.3")).toThrow("v0.7.3");
  });

  test("ignores the machine-local desktop version state", () => {
    const repositoryRoot = join(import.meta.dir, "..", "..", "..");
    const gitignore = readFileSync(join(repositoryRoot, ".gitignore"), "utf8");

    expect(gitignore).toContain("config/desktop-version.local.json");
  });
});
