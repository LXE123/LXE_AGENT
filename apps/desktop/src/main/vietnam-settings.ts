import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopVietnamMapExportKind, DesktopVietnamMapExportResult, DesktopVietnamSettingsState } from "@lxe/desktop-protocol";
import { redactAndBound, type DesktopInputAssetsOptions } from "./input-assets";

/** Native settings bridge. Python owns validation and atomic storage. */
export class DesktopVietnamSettingsService {
  constructor(private readonly options: DesktopInputAssetsOptions) {}

  private async call<T = DesktopVietnamSettingsState>(action: "read" | "save" | "upload" | "export", ...values: string[]): Promise<T> {
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const args = ["-I", "-B", "-m", "services.vietnam_replenishment.settings", action, ...values];
    const options = {
      cwd: this.options.dataRoot, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, LXE_DATA_ROOT: this.options.dataRoot, TMP: temporaryRoot, TEMP: temporaryRoot,
        TMPDIR: temporaryRoot, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    };
    const execution = this.options.execute ? await this.options.execute(args, options)
      : await new Promise<{ stdout: string; stderr: string; error: Error | null }>(resolve => {
        execFile(this.options.pythonPath, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      });
    let result: { success?: boolean; data?: T; error?: string } | undefined;
    try { result = JSON.parse(execution.stdout.trim()); } catch { /* Preserve actual process diagnostics below. */ }
    if (execution.error || result?.success !== true || !result.data) {
      throw new Error(redactAndBound(result?.error || execution.stderr || execution.error?.message
        || `Invalid Vietnam settings response: ${execution.stdout}`));
    }
    return result.data;
  }

  read(): Promise<DesktopVietnamSettingsState> { return this.call("read"); }
  save(input: unknown): Promise<DesktopVietnamSettingsState> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("越南备货参数必须是对象");
    const serialized = JSON.stringify(input);
    if (serialized.length > 4096) throw new Error("越南备货参数过长");
    return this.call("save", serialized);
  }
  upload(path: string): Promise<DesktopVietnamSettingsState> { return this.call("upload", path); }
  exportMap(kind: DesktopVietnamMapExportKind, path: string): Promise<DesktopVietnamMapExportResult> {
    return this.call<DesktopVietnamMapExportResult>("export", kind, path);
  }
}
