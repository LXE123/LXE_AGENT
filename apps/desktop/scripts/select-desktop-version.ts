import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const desktopVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface DesktopVersion {
  major: number;
  minor: number;
  patch: number;
}

export type VersionPrompt = (message: string) => Promise<string>;
export type VersionNotice = (message: string) => void;

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type VersionCommandRunner = (command: readonly [string, ...string[]]) => CommandResult;

export function parseDesktopVersion(value: string): DesktopVersion | undefined {
  const match = desktopVersionPattern.exec(value.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch };
}

export function formatDesktopVersion(version: DesktopVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareDesktopVersions(left: DesktopVersion, right: DesktopVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function bumpDesktopPatchVersion(current: DesktopVersion): DesktopVersion {
  if (current.patch >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Desktop patch version is too large to increment: ${formatDesktopVersion(current)}`);
  }
  return { ...current, patch: current.patch + 1 };
}

export async function selectDesktopVersion(
  current: DesktopVersion,
  prompt: VersionPrompt,
  notice: VersionNotice = () => {},
): Promise<DesktopVersion> {
  const automatic = bumpDesktopPatchVersion(current);
  while (true) {
    const answer = (await prompt(
      `Automatically bump patch version to ${formatDesktopVersion(automatic)}? [Y/n]: `,
    )).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return automatic;
    if (answer !== "n" && answer !== "no") {
      notice("Please answer y or n.");
      continue;
    }

    while (true) {
      const manualValue = (await prompt(
        "Enter desktop version (x.y.z, current or higher): ",
      )).trim();
      const manual = parseDesktopVersion(manualValue);
      if (!manual) {
        notice("Invalid desktop version. Use x.y.z with non-negative integers.");
        continue;
      }
      if (compareDesktopVersions(manual, current) < 0) {
        notice(`Desktop version cannot be lower than ${formatDesktopVersion(current)}.`);
        continue;
      }
      return manual;
    }
  }
}

export function readDesktopPackageVersion(packagePath: string): DesktopVersion {
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  const rawVersion = typeof manifest.version === "string" ? manifest.version : "";
  const version = parseDesktopVersion(rawVersion);
  if (!version) {
    throw new Error(`Desktop package version must use x.y.z: ${rawVersion || "<missing>"}`);
  }
  return version;
}

const runVersionCommand: VersionCommandRunner = (command) => {
  const [executable, ...arguments_] = command;
  const result = spawnSync(executable, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? new Uint8Array(),
    stderr: result.stderr ?? new Uint8Array(),
  };
};

export function updateDesktopPackageVersion(
  desktopRoot: string,
  version: DesktopVersion,
  runner: VersionCommandRunner = runVersionCommand,
): void {
  const selected = formatDesktopVersion(version);
  const result = runner([
    process.execPath,
    "pm",
    "pkg",
    "set",
    `version=${selected}`,
    "--cwd",
    desktopRoot,
  ]);
  if (result.exitCode !== 0) {
    const decoder = new TextDecoder();
    const stderr = decoder.decode(result.stderr).trim();
    const stdout = decoder.decode(result.stdout).trim();
    throw new Error(
      `Failed to update desktop package version (${result.exitCode}): ${stderr || stdout || "no command output"}`,
    );
  }

  const persisted = readDesktopPackageVersion(join(desktopRoot, "package.json"));
  if (compareDesktopVersions(persisted, version) !== 0) {
    throw new Error(
      `Desktop package version update did not persist: expected ${selected}, found ${formatDesktopVersion(persisted)}`,
    );
  }
}

async function main(): Promise<void> {
  const desktopRoot = resolve(import.meta.dirname, "..");
  const current = readDesktopPackageVersion(join(desktopRoot, "package.json"));
  const input = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Current desktop version: ${formatDesktopVersion(current)}`);
  try {
    const selected = await selectDesktopVersion(
      current,
      (message) => input.question(message),
      (message) => console.log(message),
    );
    updateDesktopPackageVersion(desktopRoot, selected);
    console.log(`Desktop version for this build: ${formatDesktopVersion(selected)}`);
  } finally {
    input.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
