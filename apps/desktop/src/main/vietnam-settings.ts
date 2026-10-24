import { managedPythonEnvironment } from "@lxe/core";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopVietnamSettingsState, DesktopVietnamTemplateExportResult } from "@lxe/desktop-protocol";
import { redactAndBound, type DesktopInputAssetsOptions } from "./input-assets";

/** Desktop consumes the lxeskill contract; Python owns validation and storage. */
export class DesktopVietnamSettingsService {
  constructor(private readonly options: DesktopInputAssetsOptions) {}

  private async call<T = DesktopVietnamSettingsState>(action: "read" | "save" | "upload" | "export", ...values: string[]): Promise<T> {
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const args = ["vietnam", "replenishment", "settings", "--action", action, ...values];
    const options = {
      cwd: this.options.dataRoot, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: managedPythonEnvironment({ ...process.env, LXE_DATA_ROOT: this.options.dataRoot,
        LXE_SQLITE_DB_PATH: join(this.options.dataRoot, "db", "lxeskill.sqlite3"),
        LXE_WORKSPACE_ROOT: join(this.options.dataRoot, "workspace"), TMP: temporaryRoot, TEMP: temporaryRoot,
        TMPDIR: temporaryRoot }),
    };
    const execution = this.options.execute ? await this.options.execute(args, options)
      : await new Promise<{ stdout: string; stderr: string; error: Error | null }>(resolve => {
        execFile(this.options.executablePath, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      });
    let result: { type?: string; ok?: boolean; data?: { success?: boolean; data?: T }; error?: { message?: string } } | undefined;
    const terminal = execution.stdout.split(/\r?\n/u).filter(line => line.trim()).at(-1) ?? "";
    try { result = JSON.parse(terminal); } catch { /* Preserve actual process diagnostics below. */ }
    if (execution.error || result?.type !== "result" || result.ok !== true || result.data?.success !== true || !result.data.data) {
      throw new Error(redactAndBound(result?.error?.message || execution.stderr || execution.error?.message
        || `Invalid lxeskill settings result: ${terminal}`));
    }
    return result.data.data;
  }

  read(): Promise<DesktopVietnamSettingsState> { return this.call("read"); }
  save(input: unknown): Promise<DesktopVietnamSettingsState> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("越南备货参数必须是对象");
    const serialized = JSON.stringify(input);
    if (serialized.length > 4096) throw new Error("越南备货参数过长");
    return this.call("save", "--parameters", serialized);
  }
  uploadTemplate(path: string): Promise<DesktopVietnamSettingsState> { return this.call("upload", "--path", path); }
  exportTemplate(path: string): Promise<DesktopVietnamTemplateExportResult> {
    return this.call<DesktopVietnamTemplateExportResult>("export", "--path", path);
  }
}
