import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  DesktopSyntheticPerformerItem,
  DesktopSyntheticPerformerOutputSelection,
  DesktopSyntheticPerformerSourceKind,
  DesktopSyntheticPerformerSourceSelection,
  DesktopSyntheticPerformerTask,
  DesktopSyntheticPerformerTaskInput,
} from "@lxe/desktop-protocol";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BYTES = 4_096;
const TASK_TIMEOUT_MS = 30 * 60 * 1_000;

interface SourceRecord extends DesktopSyntheticPerformerSourceSelection {
  paths: string[];
}

interface OutputRecord extends DesktopSyntheticPerformerOutputSelection {
  path: string;
}

interface CliRecord {
  protocol_version?: unknown;
  type?: unknown;
  ok?: unknown;
  data?: unknown;
  error?: unknown;
  stage?: unknown;
  processed?: unknown;
  total?: unknown;
  current_file?: unknown;
}

export interface DesktopSyntheticPerformerServiceOptions {
  platform: NodeJS.Platform;
  pythonPath: string;
  exifToolPath: string;
  dataRoot: string;
  managedPath: string;
  onTaskChanged?: (task: DesktopSyntheticPerformerTask) => void;
  onStderr?: (line: string) => void;
}

const cloneTask = (task: DesktopSyntheticPerformerTask): DesktopSyntheticPerformerTask => ({
  ...task,
  items: task.items.map((item) => ({ ...item })),
  counts: { ...task.counts },
});

const boundedError = (value: string): string => {
  const text = value.trim();
  return Buffer.byteLength(text, "utf8") <= MAX_ERROR_BYTES
    ? text
    : `…${Buffer.from(text, "utf8").subarray(-MAX_ERROR_BYTES).toString("utf8")}`;
};

const redactPath = (value: string, path: string, label: string): string => {
  let result = value;
  for (const spelling of new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")])) {
    result = result.split(spelling).join(label);
  }
  return result;
};

const numericValue = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const boundedRecordText = (value: unknown, label: string, maximum = 32_768): string => {
  if (typeof value !== "string") throw new Error(`lxeskill media item ${label} must be a string`);
  if (!value || value.length > maximum) throw new Error(`lxeskill media item ${label} is invalid`);
  return value;
};

const taskDirectoryName = (date = new Date()): string => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `AI人物标签-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

export class DesktopSyntheticPerformerService {
  private readonly sources = new Map<string, SourceRecord>();
  private readonly outputs = new Map<string, OutputRecord>();
  private task: DesktopSyntheticPerformerTask | null = null;
  private child: ReturnType<typeof spawn> | null = null;
  private currentRun: Promise<void> | null = null;
  private cancelRequested = false;
  private taskOutputPath = "";

  constructor(private readonly options: DesktopSyntheticPerformerServiceOptions) {}

  registerSources(
    kind: DesktopSyntheticPerformerSourceKind,
    paths: string[],
  ): DesktopSyntheticPerformerSourceSelection {
    if (!paths.length) throw new Error("No media source was selected");
    const normalized = paths.map((path) => {
      const value = String(path || "").trim();
      if (!value || !existsSync(value)) {
        throw new Error(`Selected media source is unavailable: ${basename(value) || "selection"}`);
      }
      let stats;
      try {
        stats = statSync(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redactPath(message, value, "[selected media]"));
      }
      if (kind === "files" && !stats.isFile()) {
        throw new Error(`Selected media source is not a file: ${basename(value)}`);
      }
      if (kind === "folder" && !stats.isDirectory()) {
        throw new Error(`Selected media source is not a folder: ${basename(value)}`);
      }
      return value;
    });
    const selection: SourceRecord = {
      selection_id: randomUUID(),
      kind,
      display_path: kind === "folder"
        ? basename(normalized[0]!)
        : normalized.length === 1
          ? basename(normalized[0]!)
          : `${basename(dirname(normalized[0]!))} · ${normalized.length} files`,
      selected_count: normalized.length,
      paths: normalized,
    };
    this.sources.set(selection.selection_id, selection);
    return {
      selection_id: selection.selection_id,
      kind: selection.kind,
      display_path: selection.display_path,
      selected_count: selection.selected_count,
    };
  }

  registerOutput(path: string): DesktopSyntheticPerformerOutputSelection {
    const value = String(path || "").trim();
    if (!value || !existsSync(value)) {
      throw new Error(`Selected output folder is unavailable: ${basename(value) || "selection"}`);
    }
    try {
      if (!statSync(value).isDirectory()) {
        throw new Error(`Selected output folder is unavailable: ${basename(value)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactPath(message, value, "[selected output folder]"));
    }
    const output: OutputRecord = { output_id: randomUUID(), display_path: basename(value), path: value };
    this.outputs.set(output.output_id, output);
    return { output_id: output.output_id, display_path: output.display_path };
  }

  start(input: DesktopSyntheticPerformerTaskInput): DesktopSyntheticPerformerTask {
    if (this.task?.state === "queued" || this.task?.state === "running") {
      throw new Error("A synthetic performer media task is already running");
    }
    this.requireRuntime();
    const source = this.sources.get(input.selection_id);
    if (!source) throw new Error("The selected media source has expired; select it again");
    const output = input.action === "apply" ? this.outputs.get(input.output_id) : undefined;
    if (input.action === "apply" && !output) {
      throw new Error("The selected output folder has expired; select it again");
    }
    const outputDirectory = output ? this.createOutputDirectory(output.path) : "";
    this.taskOutputPath = outputDirectory;
    this.cancelRequested = false;
    this.task = {
      task_id: randomUUID(),
      action: input.action,
      state: "queued",
      stage: "idle",
      processed: 0,
      total: 0,
      current_file: "",
      selection_id: input.selection_id,
      recursive: input.recursive,
      items: [],
      counts: {},
      error: "",
    };
    this.publish();
    const arguments_: Record<string, unknown> = {
      action: input.action,
      sources: source.paths,
      recursive: input.recursive,
      ...(outputDirectory ? { output_directory: outputDirectory } : {}),
    };
    this.currentRun = this.runCli(arguments_).finally(() => {
      this.child = null;
      this.currentRun = null;
    });
    return cloneTask(this.task);
  }

  current(): DesktopSyntheticPerformerTask | null {
    return this.task ? cloneTask(this.task) : null;
  }

  async cancel(taskId: string): Promise<DesktopSyntheticPerformerTask | null> {
    if (!this.task || this.task.task_id !== taskId) throw new Error("Synthetic performer task was not found");
    if (this.task.state !== "queued" && this.task.state !== "running") return cloneTask(this.task);
    this.cancelRequested = true;
    await this.terminateChild();
    await this.currentRun?.catch(() => undefined);
    return this.task ? cloneTask(this.task) : null;
  }

  outputPath(taskId: string): string {
    if (!this.task || this.task.task_id !== taskId) throw new Error("Synthetic performer task was not found");
    if (!this.taskOutputPath || !existsSync(this.taskOutputPath)) {
      throw new Error("Synthetic performer output folder is unavailable");
    }
    return this.taskOutputPath;
  }

  async stop(): Promise<void> {
    if (!this.task || (this.task.state !== "queued" && this.task.state !== "running")) return;
    this.cancelRequested = true;
    await this.terminateChild();
    await this.currentRun?.catch(() => undefined);
  }

  private requireRuntime(): void {
    if (this.options.platform !== "win32" && this.options.platform !== "darwin") {
      throw new Error("Amazon AI person media tagging currently supports Windows and macOS only");
    }
    if (!existsSync(this.options.pythonPath)) throw new Error(`Managed Python is unavailable: ${this.options.pythonPath}`);
    if (!existsSync(this.options.exifToolPath)) throw new Error(`ExifTool is unavailable: ${this.options.exifToolPath}`);
  }

  private createOutputDirectory(parent: string): string {
    const base = taskDirectoryName();
    for (let index = 0; index < 1_000; index += 1) {
      const path = join(parent, index === 0 ? base : `${base}-${index + 1}`);
      if (existsSync(path)) continue;
      try {
        mkdirSync(path, { recursive: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redactPath(boundedError(message), parent, "[selected output folder]"));
      }
      return path;
    }
    throw new Error("Could not create a unique synthetic performer output folder");
  }

  private async runCli(input: Record<string, unknown>): Promise<void> {
    const task = this.task;
    if (!task) return;
    task.state = "running";
    this.publish();
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const child = spawn(
      this.options.pythonPath,
      ["-I", "-B", "-m", "lxeskill", "media", "synthetic-performer", "--stdin-json"],
      {
        cwd: this.options.dataRoot,
        env: {
          ...process.env,
          LXE_DATA_ROOT: this.options.dataRoot,
          LXE_SQLITE_DB_PATH: join(this.options.dataRoot, "db", "lxeskill.sqlite3"),
          LXE_EXIFTOOL_PATH: this.options.exifToolPath,
          LXE_MANAGED_PATH: this.options.managedPath,
          PATH: [this.options.managedPath, process.env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
          TMP: temporaryRoot,
          TEMP: temporaryRoot,
          TMPDIR: temporaryRoot,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.options.platform === "darwin",
        windowsHide: true,
      },
    );
    this.child = child;
    let outputBytes = 0;
    let stderr = "";
    let terminal: CliRecord | null = null;
    let protocolError = "";
    const stdoutLines = createInterface({ input: child.stdout });
    stdoutLines.on("line", (line) => {
      outputBytes += Buffer.byteLength(line, "utf8") + 1;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        protocolError = `lxeskill output exceeds ${MAX_OUTPUT_BYTES} bytes`;
        void this.terminateChild();
        return;
      }
      let record: CliRecord;
      try {
        record = JSON.parse(line) as CliRecord;
      } catch (error) {
        protocolError = `Invalid lxeskill JSONL output: ${error instanceof Error ? error.message : String(error)}`;
        void this.terminateChild();
        return;
      }
      if (record.protocol_version !== "1" || (record.type !== "progress" && record.type !== "result")) {
        protocolError = "Invalid lxeskill JSONL record";
        void this.terminateChild();
        return;
      }
      if (record.type === "progress") {
        task.stage = record.stage === "scan" || record.stage === "apply" || record.stage === "verify"
          ? record.stage
          : task.stage;
        task.processed = numericValue(record.processed);
        task.total = numericValue(record.total);
        task.current_file = typeof record.current_file === "string"
          ? record.current_file.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? ""
          : "";
        this.publish();
      } else if (terminal) {
        protocolError = "lxeskill returned more than one terminal result";
      } else {
        terminal = record;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = boundedError(`${stderr}${text}`);
      for (const line of text.split(/\r?\n/u).filter(Boolean)) this.options.onStderr?.(line);
    });
    const timeout = setTimeout(() => {
      protocolError = `lxeskill timed out after ${TASK_TIMEOUT_MS}ms`;
      void this.terminateChild();
    }, TASK_TIMEOUT_MS);
    child.stdin.end(JSON.stringify(input));
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? -1));
      });
      if (this.cancelRequested) {
        task.state = "cancelled";
        task.stage = "done";
        task.current_file = "";
        this.publish();
        return;
      }
      if (protocolError) throw new Error(protocolError);
      const terminalRecord = terminal as CliRecord | null;
      if (!terminalRecord) throw new Error(`lxeskill produced no terminal result${stderr ? `: ${stderr}` : ""}`);
      const errorObject = terminalRecord.error && typeof terminalRecord.error === "object"
        ? terminalRecord.error as Record<string, unknown>
        : {};
      if (exitCode !== 0 || terminalRecord.ok !== true) {
        const message = String(errorObject.message || stderr || `lxeskill exited with ${exitCode}`);
        throw new Error(boundedError(message));
      }
      const data = terminalRecord.data && typeof terminalRecord.data === "object"
        ? terminalRecord.data as Record<string, unknown>
        : {};
      task.items = this.safeItems(data.items, task.action);
      task.counts = Object.fromEntries(
        [...new Set(task.items.map((item) => item.status))]
          .map((status) => [status, task.items.filter((item) => item.status === status).length]),
      );
      task.processed = task.items.length;
      task.total = task.items.length;
      task.current_file = "";
      task.stage = "done";
      task.state = "completed";
      this.publish();
    } catch (error) {
      task.state = this.cancelRequested ? "cancelled" : "failed";
      task.stage = "done";
      task.current_file = "";
      task.error = this.safeError(error instanceof Error ? error.message : String(error));
      this.publish();
    } finally {
      clearTimeout(timeout);
      stdoutLines.close();
    }
  }

  private publish(): void {
    if (this.task) this.options.onTaskChanged?.(cloneTask(this.task));
  }

  private safeItems(value: unknown, action: "scan" | "apply"): DesktopSyntheticPerformerItem[] {
    if (!Array.isArray(value)) throw new Error("lxeskill media result items must be an array");
    const allowedStatuses = action === "scan"
      ? new Set(["needs_tag", "already_tagged", "unsupported", "failed"])
      : new Set(["tagged", "copied", "failed"]);
    return value.map((raw): DesktopSyntheticPerformerItem => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("lxeskill media item must be an object");
      }
      const item = raw as Record<string, unknown>;
      const relativePath = boundedRecordText(item.relative_path, "relative_path").replaceAll("\\", "/");
      const segments = relativePath.split("/");
      if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)
        || segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("lxeskill media item relative_path is unsafe");
      }
      const mediaType = item.media_type;
      if (mediaType !== "image" && mediaType !== "video") {
        throw new Error("lxeskill media item media_type is invalid");
      }
      const status = boundedRecordText(item.status, "status", 64);
      if (!allowedStatuses.has(status)) throw new Error("lxeskill media item status is invalid");
      const sizeBytes = numericValue(item.size_bytes);
      return {
        name: segments.at(-1)!,
        relative_path: relativePath,
        media_type: mediaType,
        status: status as DesktopSyntheticPerformerItem["status"],
        size_bytes: sizeBytes,
        ...(typeof item.error === "string" && item.error.trim()
          ? { error: this.safeError(item.error) }
          : {}),
      };
    });
  }

  private safeError(value: string): string {
    let result = boundedError(value);
    const selected = this.task ? this.sources.get(this.task.selection_id) : undefined;
    const replacements = [
      ...(selected?.paths.map((path) => [path, "[selected media]"] as const) ?? []),
      ...(this.taskOutputPath ? [[this.taskOutputPath, "[output folder]"] as const] : []),
    ];
    for (const [path, label] of replacements) {
      result = redactPath(result, path, label);
    }
    return result;
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (this.options.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
    } else if (this.options.platform === "darwin" && child.pid) {
      const processGroup = -child.pid;
      try {
        process.kill(processGroup, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process already exited.
        }
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timeout = setTimeout(resolve, 1_500);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      try {
        process.kill(processGroup, 0);
        process.kill(processGroup, "SIGKILL");
      } catch {
        // The complete process group already exited.
      }
    }
    try {
      child.kill();
    } catch {
      // The process already exited.
    }
  }
}

export const syntheticPerformerTaskDirectoryName = taskDirectoryName;
