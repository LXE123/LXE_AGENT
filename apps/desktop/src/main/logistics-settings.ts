import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";
import { redactAndBound, type DesktopInputAssetsOptions } from "./input-assets";
import { validateLogisticsProfileId, validateLogisticsProfileInput, validateLogisticsRevision } from "./ipc-validation";

type Options = DesktopInputAssetsOptions & { environment: () => NodeJS.ProcessEnv };

/** Private fixed-module bridge; Python owns business input storage. */
export class DesktopLogisticsSettingsService {
  constructor(private readonly options: Options) {}

  private async call(action: "read" | "refresh" | "save" | "delete", request?: object): Promise<DesktopLogisticsSettingsState> {
    const temporaryRoot = join(this.options.dataRoot, "tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const args = ["-I", "-B", "-m", "services.agent_cli.logistics.settings", action,
      ...(request ? [JSON.stringify(request)] : [])];
    const environment = { ...process.env, ...this.options.environment(), LXE_DATA_ROOT: this.options.dataRoot,
      TMP: temporaryRoot, TEMP: temporaryRoot, TMPDIR: temporaryRoot, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    const safe = (message: string): string => {
      for (const [name, value] of Object.entries(environment)) {
        if (value && /PASSWORD|SECRET|TOKEN|COOKIE|API_KEY|AUTHORIZATION/iu.test(name)) message = message.replaceAll(value, "[redacted]");
      }
      return redactAndBound(message);
    };
    const options = { cwd: this.options.dataRoot, timeout: 260_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: environment };
    const execution = this.options.execute ? await this.options.execute(args, options)
      : await new Promise<{ stdout: string; stderr: string; error: Error | null }>(resolve => {
        execFile(this.options.pythonPath, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      });
    let result: { success?: boolean; data?: DesktopLogisticsSettingsState; error?: string } | undefined;
    try { result = JSON.parse(execution.stdout.trim()); } catch { /* Include actual diagnostics below. */ }
    if (execution.error || result?.success !== true || !result.data || result.data.schema_version !== 1
      || !Number.isSafeInteger(result.data.revision) || result.data.revision < 0
      || !(result.data.stores_error === null || typeof result.data.stores_error === "string") || !Array.isArray(result.data.profiles)
      || !Array.isArray(result.data.providers) || !Array.isArray(result.data.stores)) {
      throw new Error(safe([result?.error, execution.stderr, execution.error?.message,
        `Logistics settings response: ${execution.stdout}`].filter(Boolean).join("\n")));
    }
    return { ...result.data, stores_error: result.data.stores_error ? safe(result.data.stores_error) : null };
  }
  read(): Promise<DesktopLogisticsSettingsState> { return this.call("read"); }
  refresh(): Promise<DesktopLogisticsSettingsState> { return this.call("refresh"); }
  save(input: unknown, expectedRevision: unknown): Promise<DesktopLogisticsSettingsState> {
    return this.call("save", { input: validateLogisticsProfileInput(input), expected_revision: validateLogisticsRevision(expectedRevision) });
  }
  delete(id: unknown, expectedRevision: unknown): Promise<DesktopLogisticsSettingsState> {
    return this.call("delete", { profile_id: validateLogisticsProfileId(id), expected_revision: validateLogisticsRevision(expectedRevision) });
  }
}
