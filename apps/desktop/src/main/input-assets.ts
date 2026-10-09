import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  DesktopInputAssetSlot,
  DesktopInputAssetVersion,
  DesktopVietnamSkuMapMutation,
} from "@lxe/desktop-protocol";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 4_096;
const LIST_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const REVISION = /^[0-9a-f]{32}$/u;

export interface AssetCommandExecution {
  stdout: string;
  stderr: string;
  error: Error | null;
}

type AssetCommandExecutor = (args: string[], options: ExecFileOptions) => Promise<AssetCommandExecution>;

export interface DesktopInputAssetsOptions {
  dataRoot: string;
  pythonPath: string;
  managedPath: string;
  platform: NodeJS.Platform;
  execute?: AssetCommandExecutor;
}

const secretNames = /(?:PASSWORD|SECRET|TOKEN|COOKIE|SESSION|API_KEY|MOBILE)$/iu;

const redactAndBound = (message: string): string => {
  let detail = message.trim();
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secretNames.test(name)) detail = detail.replaceAll(secret, "[redacted]");
  }
  const encoded = Buffer.from(detail, "utf8");
  return encoded.length <= MAX_ERROR_BYTES
    ? detail
    : `[truncated] ${encoded.subarray(-MAX_ERROR_BYTES).toString("utf8")}`;
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const parseLastResult = (stdout: string): Record<string, unknown> | null => {
  const terminal = stdout.split(/\r?\n/u).filter(line => line.trim()).at(-1);
  if (!terminal) return null;
  try {
    const parsed = objectValue(JSON.parse(terminal));
    return parsed?.type === "result" ? parsed : null;
  } catch {
    return null;
  }
};

const errorMessage = (record: Record<string, unknown> | null): string => {
  if (!record) return "";
  const data = objectValue(record.data);
  const error = objectValue(record.error);
  const dataError = objectValue(data?.error);
  return [error?.message, dataError?.message, data?.exception]
    .find(value => typeof value === "string" && value.trim()) as string | undefined ?? "";
};

const versionValue = (value: unknown): DesktopInputAssetVersion | null => {
  const item = objectValue(value);
  if (!item) return null;
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
  const item = objectValue(value);
  if (!item) return null;
  const slot = String(item.slot ?? "").trim();
  const displayName = String(item.display_name ?? "").trim();
  const usedBy = Array.isArray(item.used_by)
    ? item.used_by.map(usage => String(usage).trim()).filter(Boolean)
    : [];
  const directory = String(item.directory ?? "").trim();
  if (!slot || !displayName || usedBy.length === 0 || !directory) return null;
  if (item.management !== "desktop" && item.management !== "command") {
    throw new Error(`Input asset ${slot} has invalid management: ${String(item.management)}`);
  }
  const revision = item.manifest_revision ?? null;
  if (revision !== null && (typeof revision !== "string" || !REVISION.test(revision))) {
    throw new Error(`Input asset ${slot} has invalid manifest revision`);
  }
  const field = (name: "current_error" | "previous_error" | "manifest_error") => {
    const value = item[name];
    return typeof value === "string" && value.trim() ? { [name]: redactAndBound(value) } : {};
  };
  return {
    slot,
    management: item.management,
    manifest_revision: revision,
    ...field("current_error"),
    ...field("previous_error"),
    ...field("manifest_error"),
    display_name: displayName,
    used_by: usedBy,
    holds: String(item.holds ?? ""),
    directory,
    current: versionValue(item.current),
    previous: versionValue(item.previous),
  };
};

const executeFile = (pythonPath: string, args: string[], options: ExecFileOptions): Promise<AssetCommandExecution> =>
  new Promise(resolve => {
    execFile(pythonPath, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The Python asset registry and managed slot store remain the only source of truth. */
export class DesktopInputAssetsService {
  constructor(private readonly options: DesktopInputAssetsOptions) {}

  private async runAssetCommand(command: string[], flags: string[], timeout: number): Promise<Record<string, unknown>> {
    if (!existsSync(this.options.pythonPath)) {
      throw new Error(`Managed Python is unavailable: ${this.options.pythonPath}`);
    }
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const separator = this.options.platform === "win32" ? ";" : ":";
    const args = ["-I", "-B", "-m", "lxeskill", ...command, ...flags];
    const options: ExecFileOptions = {
      cwd: this.options.dataRoot,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        ...process.env,
        LXE_DATA_ROOT: this.options.dataRoot,
        LXE_SQLITE_DB_PATH: join(this.options.dataRoot, "db", "lxeskill.sqlite3"),
        LXE_WORKSPACE_ROOT: join(this.options.dataRoot, "workspace"),
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
    };
    const execution = this.options.execute
      ? await this.options.execute(args, options)
      : await executeFile(this.options.pythonPath, args, options);
    const record = parseLastResult(execution.stdout);
    const data = objectValue(record?.data);
    if (execution.error || record?.ok !== true || data?.success === false) {
      const terminal = execution.stdout.split(/\r?\n/u).filter(line => line.trim()).at(-1) ?? "";
      const observed = errorMessage(record) || execution.stderr.trim() || execution.error?.message
        || (terminal ? `Invalid lxeskill result: ${terminal}` : "lxeskill produced no result");
      throw new Error(redactAndBound(observed));
    }
    if (!data) throw new Error(`lxeskill ${command.join(" ")} returned no data`);
    return data;
  }

  async list(): Promise<DesktopInputAssetSlot[]> {
    const data = await this.runAssetCommand(["assets", "list"], [], LIST_TIMEOUT_MS);
    if (!Array.isArray(data.slots)) throw new Error("lxeskill assets list returned no slots");
    return data.slots.map(slotValue).filter((slot): slot is DesktopInputAssetSlot => slot !== null);
  }

  async installVietnamSkuMap(sourcePath: string, expectedRevision: string | null): Promise<DesktopVietnamSkuMapMutation> {
    if (!isAbsolute(sourcePath)) throw new Error("Selected SKU map path must be absolute");
    if (expectedRevision !== null && !REVISION.test(expectedRevision)) throw new Error("Invalid SKU map revision");
    const data = await this.runAssetCommand(
      ["assets", "vietnam", "sku", "install"],
      ["--source-path", sourcePath, "--expected-revision", expectedRevision ?? ""],
      INSTALL_TIMEOUT_MS,
    );
    return this.mutationValue(data, ["installed", "unchanged"]);
  }

  async rollbackVietnamSkuMap(expectedRevision: string): Promise<DesktopVietnamSkuMapMutation> {
    if (!REVISION.test(expectedRevision)) throw new Error("Invalid SKU map revision");
    const data = await this.runAssetCommand(
      ["assets", "vietnam", "sku", "rollback"],
      ["--expected-revision", expectedRevision],
      LIST_TIMEOUT_MS,
    );
    return this.mutationValue(data, ["rolled_back"]);
  }

  private mutationValue(data: Record<string, unknown>, accepted: readonly DesktopVietnamSkuMapMutation["status"][]): DesktopVietnamSkuMapMutation {
    if (!accepted.includes(data.status as DesktopVietnamSkuMapMutation["status"])
      || typeof data.manifest_revision !== "string" || !REVISION.test(data.manifest_revision)) {
      throw new Error("lxeskill Vietnam SKU map command returned an invalid result");
    }
    return { status: data.status as DesktopVietnamSkuMapMutation["status"], manifest_revision: data.manifest_revision };
  }

  async directoryFor(slot: string): Promise<string> {
    const match = (await this.list()).find(item => item.slot === slot);
    if (!match) throw new Error(`Unknown input asset slot: ${slot}`);
    mkdirSync(match.directory, { recursive: true });
    return match.directory;
  }
}
