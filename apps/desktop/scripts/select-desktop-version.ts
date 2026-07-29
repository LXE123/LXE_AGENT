import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const desktopVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const desktopVersionStateSchema = 1;
const initialDesktopVersion: DesktopVersion = { major: 0, minor: 1, patch: 0 };

export interface DesktopVersion {
  major: number;
  minor: number;
  patch: number;
}

export type DesktopVersionMode = "select" | "current";
export type VersionPrompt = (message: string) => Promise<string>;
export type VersionNotice = (message: string) => void;

interface DesktopVersionStateDocument {
  schema_version: number;
  last_successful_version: string;
}

interface DesktopVersionSelectionDocument {
  schema_version: number;
  selected_version: string;
}

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

const actualError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const readJsonDocument = (path: string, label: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${path}: ${actualError(error)}`);
  }
};

const writeJsonDocument = (path: string, document: object): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
};

const requireDocument = (value: unknown, path: string, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} at ${path} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
};

const requireVersionField = (
  document: Record<string, unknown>,
  field: string,
  path: string,
  label: string,
): DesktopVersion => {
  if (document.schema_version !== desktopVersionStateSchema) {
    throw new Error(
      `${label} at ${path} has unsupported schema_version: ${String(document.schema_version ?? "missing")}.`,
    );
  }
  const rawVersion = typeof document[field] === "string" ? document[field] : "";
  const version = parseDesktopVersion(rawVersion);
  if (!version) {
    throw new Error(`${label} at ${path} has invalid ${field}: ${rawVersion || "<missing>"}.`);
  }
  return version;
};

const writeDesktopVersionState = (statePath: string, version: DesktopVersion): void => {
  const document: DesktopVersionStateDocument = {
    schema_version: desktopVersionStateSchema,
    last_successful_version: formatDesktopVersion(version),
  };
  writeJsonDocument(statePath, document);
};

const writeDesktopVersionSelection = (selectionPath: string, version: DesktopVersion): void => {
  const document: DesktopVersionSelectionDocument = {
    schema_version: desktopVersionStateSchema,
    selected_version: formatDesktopVersion(version),
  };
  writeJsonDocument(selectionPath, document);
};

export function readDesktopVersionState(statePath: string): DesktopVersion {
  if (!existsSync(statePath)) {
    writeDesktopVersionState(statePath, initialDesktopVersion);
    return { ...initialDesktopVersion };
  }
  const document = requireDocument(
    readJsonDocument(statePath, "desktop version state"),
    statePath,
    "Desktop version state",
  );
  return requireVersionField(
    document,
    "last_successful_version",
    statePath,
    "Desktop version state",
  );
}

const readDesktopVersionSelection = (selectionPath: string): DesktopVersion => {
  if (!existsSync(selectionPath)) {
    throw new Error(`Desktop version selection file is missing: ${selectionPath}`);
  }
  const document = requireDocument(
    readJsonDocument(selectionPath, "desktop version selection"),
    selectionPath,
    "Desktop version selection",
  );
  return requireVersionField(
    document,
    "selected_version",
    selectionPath,
    "Desktop version selection",
  );
};

export async function prepareDesktopVersionSelection(
  mode: DesktopVersionMode,
  statePath: string,
  selectionPath: string,
  prompt: VersionPrompt,
  notice: VersionNotice = () => {},
): Promise<DesktopVersion> {
  const current = readDesktopVersionState(statePath);
  const selected = mode === "select"
    ? await selectDesktopVersion(current, prompt, notice)
    : current;
  writeDesktopVersionSelection(selectionPath, selected);
  return selected;
}

export function commitDesktopVersionSelection(statePath: string, selectionPath: string): DesktopVersion {
  const current = readDesktopVersionState(statePath);
  const selected = readDesktopVersionSelection(selectionPath);
  if (compareDesktopVersions(selected, current) < 0) {
    throw new Error(
      `Desktop version selection cannot lower the last successful version from ${formatDesktopVersion(current)} to ${formatDesktopVersion(selected)}.`,
    );
  }
  writeDesktopVersionState(statePath, selected);
  return selected;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
  const statePath = join(repositoryRoot, "config", "desktop-version.local.json");
  const selectionPath = join(repositoryRoot, "build", "desktop-version-selection.json");
  const action = process.argv[2];

  if (action === "commit") {
    const committed = commitDesktopVersionSelection(statePath, selectionPath);
    console.log(`Recorded successful desktop version: ${formatDesktopVersion(committed)}`);
    return;
  }
  if (action !== "select" && action !== "current") {
    throw new Error("Desktop version action must be one of: select, current, commit.");
  }

  const input = action === "select"
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  const current = readDesktopVersionState(statePath);
  console.log(`Current desktop version: ${formatDesktopVersion(current)}`);
  try {
    const selected = await prepareDesktopVersionSelection(
      action,
      statePath,
      selectionPath,
      (message) => {
        if (!input) throw new Error("Unpacked version selection must not prompt for input.");
        return input.question(message);
      },
      (message) => console.log(message),
    );
    console.log(`Desktop version for this build: ${formatDesktopVersion(selected)}`);
  } finally {
    input?.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
