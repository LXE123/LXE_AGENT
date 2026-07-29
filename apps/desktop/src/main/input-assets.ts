import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopInputAssetSlot, DesktopInputAssetVersion } from "@lxe/desktop-protocol";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 4_096;
const LIST_TIMEOUT_MS = 30_000;

export interface DesktopInputAssetsOptions {
  dataRoot: string;
  pythonPath: string;
  managedPath: string;
  platform: NodeJS.Platform;
}

const boundedError = (value: string): string => {
  const text = value.trim();
  return text.length <= MAX_ERROR_BYTES ? text : `…${text.slice(-MAX_ERROR_BYTES)}`;
};

const versionValue = (value: unknown): DesktopInputAssetVersion | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const fileName = String(item.file_name ?? "").trim();
  const path = String(item.path ?? "").trim();
  if (!fileName || !path) return null;
  const size = Number(item.size_bytes);
  return {
    file_name: fileName,
    path,
    size_bytes: Number.isFinite(size) && size >= 0 ? size : 0,
    updated_at: String(item.updated_at ?? ""),
  };
};

const slotValue = (value: unknown): DesktopInputAssetSlot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const slot = String(item.slot ?? "").trim();
  const directory = String(item.directory ?? "").trim();
  if (!slot || !directory) return null;
  return {
    slot,
    holds: String(item.holds ?? ""),
    directory,
    current: versionValue(item.current),
    previous: versionValue(item.previous),
  };
};

/** Read-only bridge onto the lxeskill asset slots.
 *
 * The slot layout, rotation rules and naming all live in Python; this only
 * shells out and validates the shape, so the two sides cannot drift.
 */
export class DesktopInputAssetsService {
  constructor(private readonly options: DesktopInputAssetsOptions) {}

  async list(): Promise<DesktopInputAssetSlot[]> {
    if (!existsSync(this.options.pythonPath)) {
      throw new Error(`Managed Python is unavailable: ${this.options.pythonPath}`);
    }
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const separator = this.options.platform === "win32" ? ";" : ":";
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.options.pythonPath,
        ["-I", "-B", "-m", "lxeskill", "assets", "list"],
        {
          cwd: this.options.dataRoot,
          timeout: LIST_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          env: {
            ...process.env,
            LXE_DATA_ROOT: this.options.dataRoot,
            LXE_SQLITE_DB_PATH: join(this.options.dataRoot, "db", "lxeskill.sqlite3"),
            LXE_MANAGED_PATH: this.options.managedPath,
            PATH: [this.options.managedPath, process.env.PATH].filter(Boolean).join(separator),
            TMP: temporaryRoot,
            TEMP: temporaryRoot,
            TMPDIR: temporaryRoot,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONNOUSERSITE: "1",
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
          },
        },
        (error, out, errorOutput) => {
          if (error) {
            // Surface what the CLI actually said; its stderr is the real cause.
            const detail = boundedError(String(errorOutput || error.message));
            reject(new Error(detail));
            return;
          }
          resolve(String(out));
        },
      );
    });

    const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
    const terminal = lines.at(-1);
    if (!terminal) throw new Error("lxeskill assets list produced no output");
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(terminal) as Record<string, unknown>;
    } catch {
      throw new Error("lxeskill assets list produced malformed output");
    }
    if (record.ok !== true) {
      const failure = (record.error ?? {}) as Record<string, unknown>;
      throw new Error(boundedError(String(failure.message ?? "lxeskill assets list failed")));
    }
    const data = (record.data ?? {}) as Record<string, unknown>;
    const slots = Array.isArray(data.slots) ? data.slots : [];
    return slots.map(slotValue).filter((slot): slot is DesktopInputAssetSlot => slot !== null);
  }

  async directoryFor(slot: string): Promise<string> {
    const match = (await this.list()).find((item) => item.slot === slot);
    if (!match) throw new Error(`Unknown input asset slot: ${slot}`);
    // A slot directory only exists once something has been promoted into it;
    // create it so "show in folder" works on a slot that is still empty.
    mkdirSync(match.directory, { recursive: true });
    return match.directory;
  }
}
