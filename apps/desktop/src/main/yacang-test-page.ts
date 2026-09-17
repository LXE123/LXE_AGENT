import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  DesktopYacangExecuteInput,
  DesktopYacangExecution,
  DesktopYacangPreview,
  DesktopYacangPreviewInput,
} from "@lxe/desktop-protocol";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60 * 1000;

export interface DesktopYacangTestPageServiceOptions {
  pythonPath: string;
  dataRoot: string;
  managedPath: string;
  environment: () => NodeJS.ProcessEnv;
  skillScope: () => Promise<readonly string[]>;
}

export function buildYacangTestPageEnvironment(
  options: DesktopYacangTestPageServiceOptions,
  skillScope: readonly string[],
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const temporaryRoot = join(options.dataRoot, "tmp");
  return {
    ...parentEnvironment,
    ...options.environment(),
    LXE_DATA_ROOT: options.dataRoot,
    LXE_SQLITE_DB_PATH: join(options.dataRoot, "db", "lxeskill.sqlite3"),
    LXE_MANAGED_PATH: options.managedPath,
    PATH: [options.managedPath, parentEnvironment.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    LXESKILL_SKILL_SCOPE: [...new Set(skillScope.map((name) => name.trim()).filter(Boolean))].join(","),
  };
}

type PreviewRecord = { requestText: string; expiresAt: number };

export class DesktopYacangTestPageService {
  private readonly previews = new Map<string, PreviewRecord>();
  constructor(private readonly options: DesktopYacangTestPageServiceOptions) {}

  async preview(input: DesktopYacangPreviewInput): Promise<DesktopYacangPreview> {
    const data = await this.run("preview", { request_text: input.request_text });
    const plan = record(data.plan, "Yacang preview plan");
    const previewId = randomUUID();
    this.previews.set(previewId, { requestText: input.request_text, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return { preview_id: previewId, plan, production_enabled: process.env.LXE_YACANG_PROD_ENABLED === "true" };
  }

  async execute(input: DesktopYacangExecuteInput): Promise<DesktopYacangExecution> {
    const preview = this.previews.get(input.preview_id);
    this.previews.delete(input.preview_id);
    if (!preview || preview.expiresAt < Date.now()) throw new Error("雅仓预览已过期，请重新解析后再确认执行");
    return { result: await this.run("run", { request_text: preview.requestText }) };
  }

  private async run(action: "preview" | "run", input: Record<string, string>): Promise<Record<string, unknown>> {
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const skillScope = await this.options.skillScope();
    const child = spawn(this.options.pythonPath, ["-I", "-B", "-m", "lxeskill", "yacang", "export", action, "--stdin-json"], {
      cwd: this.options.dataRoot,
      env: buildYacangTestPageEnvironment(this.options, skillScope),
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let outputBytes = 0;
    let terminal: Record<string, unknown> | undefined;
    let stderr = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      outputBytes += Buffer.byteLength(line, "utf8") + 1;
      if (outputBytes > MAX_OUTPUT_BYTES) { child.kill(); return; }
      try { const parsed = JSON.parse(line); if (parsed?.type === "result") terminal = parsed; } catch { child.kill(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096); });
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", value => resolve(value ?? -1)); });
    lines.close();
    if (code !== 0 || !terminal || terminal.ok !== true) throw commandError(terminal, stderr);
    const result = record(terminal.data, "Yacang CLI result");
    return result;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 无效`);
  return value as Record<string, unknown>;
}

function safeError(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [已脱敏]")
    .replace(/((?:password|token|cookie|authorization|secret)["']?\s*[:=]\s*)(?:["'][^"'\r\n]*["']|[^\s,}\r\n]+)/giu, "$1[已脱敏]")
    .trim()
    .slice(-4096);
}

function commandError(terminal: Record<string, unknown> | undefined, stderr: string): Error {
  const rawError = terminal?.error;
  const structured = rawError && typeof rawError === "object" && !Array.isArray(rawError)
    ? rawError as Record<string, unknown>
    : undefined;
  const code = typeof structured?.code === "string" && structured.code.trim()
    ? structured.code.trim()
    : "YACANG_CLI_ERROR";
  const message = safeError(
    typeof structured?.message === "string" && structured.message.trim()
      ? structured.message
      : stderr || "雅仓命令未返回有效结果",
  );
  const diagnostics = safeError(stderr);
  return new Error(JSON.stringify({ code, message, ...(diagnostics ? { diagnostics } : {}) }));
}
