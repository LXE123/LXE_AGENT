import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopLogisticsProfile, DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";
import { redactAndBound, type DesktopInputAssetsOptions } from "./input-assets";
import { validateLogisticsProfileId, validateLogisticsProfileInput, validateLogisticsRevision } from "./ipc-validation";
import type { SafeStoragePort } from "./config-store/repository";
import { DesktopLogisticsCredentialStore } from "./logistics-credentials";

type Options = DesktopInputAssetsOptions & { environment: () => NodeJS.ProcessEnv; safeStorage: SafeStoragePort };
type StoredProfile = Omit<DesktopLogisticsProfile, "password_configured"> & { credential_id: string | null };
type StoredState = Omit<DesktopLogisticsSettingsState, "profiles"> & { profiles: StoredProfile[] };

/** Private fixed-module bridge; Python owns business input storage. */
export class DesktopLogisticsSettingsService {
  private readonly credentials: DesktopLogisticsCredentialStore;
  constructor(private readonly options: Options) {
    this.credentials = new DesktopLogisticsCredentialStore(options.dataRoot, options.safeStorage);
  }

  private async call(action: "read" | "refresh" | "snapshot" | "save" | "delete", request?: object): Promise<StoredState> {
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
    let execution: { stdout: string; stderr: string; error: Error | null };
    try {
      execution = this.options.execute ? await this.options.execute(args, options)
        : await new Promise<{ stdout: string; stderr: string; error: Error | null }>(resolve => {
          execFile(this.options.pythonPath, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
        });
    } catch (error) { throw new Error(safe(error instanceof Error ? error.message : String(error))); }
    let result: { success?: boolean; data?: StoredState; error?: string } | undefined;
    try { result = JSON.parse(execution.stdout.trim()); } catch { /* Include actual diagnostics below. */ }
    if (execution.error || result?.success !== true || !result.data || result.data.schema_version !== 2
      || !Number.isSafeInteger(result.data.revision) || result.data.revision < 0
      || !(result.data.stores_error === null || typeof result.data.stores_error === "string") || !Array.isArray(result.data.profiles)
      || !Array.isArray(result.data.providers) || !Array.isArray(result.data.stores)) {
      throw new Error(safe([result?.error, execution.stderr, execution.error?.message,
        `Logistics settings response: ${execution.stdout}`].filter(Boolean).join("\n")));
    }
    return { ...result.data, stores_error: result.data.stores_error ? safe(result.data.stores_error) : null };
  }
  private publicState(state: StoredState): DesktopLogisticsSettingsState {
    return { schema_version: state.schema_version, revision: state.revision, providers: state.providers,
      stores: state.stores, stores_error: state.stores_error, profiles: state.profiles.map(profile => ({
        profile_id: profile.profile_id, display_name: profile.display_name, provider_id: profile.provider_id,
        enabled: profile.enabled, store_binding: profile.store_binding, account_name: profile.account_name,
        login_username: profile.login_username, created_at: profile.created_at, updated_at: profile.updated_at,
        password_configured: profile.credential_id !== null && this.credentials.has(profile.credential_id),
      })) };
  }
  private cleanup(before: StoredState, after: StoredState): void {
    const retained = new Set(after.profiles.map(profile => profile.credential_id));
    for (const profile of before.profiles) {
      if (profile.credential_id && !retained.has(profile.credential_id)) this.credentials.remove(profile.credential_id);
    }
  }
  async read(): Promise<DesktopLogisticsSettingsState> { return this.publicState(await this.call("read")); }
  async refresh(): Promise<DesktopLogisticsSettingsState> { return this.publicState(await this.call("refresh")); }
  async save(raw: unknown, expectedRevision: unknown): Promise<DesktopLogisticsSettingsState> {
    const { password, ...input } = validateLogisticsProfileInput(raw);
    const revision = validateLogisticsRevision(expectedRevision);
    try {
      const before = await this.call("snapshot");
      if (before.revision !== revision) throw new Error("Revision conflict: reload logistics settings before saving");
      const existing = before.profiles.find(profile => profile.profile_id === input.profile_id);
      if (input.profile_id && !existing) throw new Error("Logistics profile does not exist; reload settings");
      const username = input.login_username === undefined ? existing?.login_username ?? null : input.login_username;
      let credential = existing?.credential_id ?? null;
      if (password === undefined && credential && (username !== existing?.login_username || input.provider_id !== existing?.provider_id)) {
        throw new Error("Enter a new password when changing the login account or provider, or clear the saved password");
      }
      if (password === null) credential = null;
      else if (typeof password === "string") {
        if (!username) throw new Error("A login username is required when saving a password");
        credential = this.credentials.write({ provider_id: input.provider_id, login_username: username, password });
      }
      // Never pass the password to Python, argv, environment, or public JSON.
      // If the child outcome is uncertain, retain the new encrypted entry: it
      // may already be referenced by an atomically committed profile revision.
      const after = await this.call("save", { input: { ...input, login_username: username, credential_id: credential }, expected_revision: revision });
      this.cleanup(before, after);
      return this.publicState(after);
    } catch (error) {
      const actual = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(redactAndBound(typeof password === "string" ? actual.replaceAll(password, "[redacted]") : actual));
    }
  }
  async delete(id: unknown, expectedRevision: unknown): Promise<DesktopLogisticsSettingsState> {
    const identifier = validateLogisticsProfileId(id), revision = validateLogisticsRevision(expectedRevision);
    const before = await this.call("snapshot");
    if (before.revision !== revision) throw new Error("Revision conflict: reload logistics settings before saving");
    const after = await this.call("delete", { profile_id: identifier, expected_revision: revision });
    this.cleanup(before, after);
    return this.publicState(after);
  }
}
