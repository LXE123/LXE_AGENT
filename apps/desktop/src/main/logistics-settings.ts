import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DesktopLogisticsProfile, DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";
import { redactAndBound, type DesktopInputAssetsOptions } from "./input-assets";
import { validateLogisticsProfileId, validateLogisticsProfileInput, validateLogisticsRevision } from "./ipc-validation";
import type { SafeStoragePort } from "./config-store/repository";
import { DesktopLogisticsCredentialStore } from "./logistics-credentials";
import type { LogisticsLoginRequest } from "./logistics-login-host";

type LoginExecution = { stdout: string; stderr: string; error: Error | null };
type Options = DesktopInputAssetsOptions & { environment: () => NodeJS.ProcessEnv; safeStorage: SafeStoragePort;
  executeLogin?: (args: string[], environment: NodeJS.ProcessEnv, stdin: string) => Promise<LoginExecution> };
type StoredProfile = Omit<DesktopLogisticsProfile, "password_configured"> & { credential_id: string | null };
type StoredState = Omit<DesktopLogisticsSettingsState, "profiles"> & { profiles: StoredProfile[] };

/** Private fixed-module bridge; Python owns business input storage. */
export class DesktopLogisticsSettingsService {
  private readonly credentials: DesktopLogisticsCredentialStore;
  private readonly loginChildren = new Set<ChildProcess>();
  private loginStopping = false;
  constructor(private readonly options: Options) {
    this.credentials = new DesktopLogisticsCredentialStore(options.dataRoot, options.safeStorage);
  }

  private async call(action: "read" | "snapshot" | "save" | "delete", request?: object): Promise<StoredState> {
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
    if (execution.error || result?.success !== true || !result.data || result.data.schema_version !== 3
      || !Number.isSafeInteger(result.data.revision) || result.data.revision < 0
      || !Array.isArray(result.data.profiles) || !Array.isArray(result.data.providers)) {
      throw new Error(safe([result?.error, execution.stderr, execution.error?.message,
        `Logistics settings response: ${execution.stdout}`].filter(Boolean).join("\n")));
    }
    return result.data;
  }
  private publicState(state: StoredState): DesktopLogisticsSettingsState {
    return { schema_version: state.schema_version, revision: state.revision, providers: state.providers,
      profiles: state.profiles.map(profile => ({
        profile_id: profile.profile_id, display_name: profile.display_name, provider_id: profile.provider_id,
        enabled: profile.enabled, account_name: profile.account_name,
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
  async stopLogins(): Promise<void> {
    this.loginStopping = true;
    await Promise.all([...this.loginChildren].map(child => new Promise<void>(resolve => {
      child.once("close", () => resolve()); child.kill();
    })));
  }
  /** Only the authenticated internal login host calls this. No renderer IPC. */
  async ensureLogin(request: LogisticsLoginRequest, signal?: AbortSignal): Promise<unknown> {
    let password = "";
    const redact = (value: string): string => {
      if (!password) return value;
      for (const secret of new Set([JSON.stringify(password).slice(1, -1), password])) value = value.replaceAll(secret, "[redacted]");
      return value;
    };
    const safe = (value: string): string => redactAndBound(redact(value));
    const publicValue = (value: unknown): unknown => {
      if (typeof value === "string") return safe(value);
      if (Array.isArray(value)) return value.map(publicValue);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) =>
        [key, /password|token|cookie|secret|credential/iu.test(key) ? "[redacted]" : publicValue(child)]));
      return value;
    };
    try {
      if (this.loginStopping) throw new Error("Logistics login service is stopping");
      signal?.throwIfAborted();
      const id = validateLogisticsProfileId(request.profile_id);
      const snapshot = await this.call("snapshot");
      if (snapshot.revision !== validateLogisticsRevision(request.expected_revision)) throw new Error("Revision conflict: reload logistics profiles before login");
      const profile = snapshot.profiles.find(item => item.profile_id === id);
      if (!profile || !profile.enabled) throw new Error("Logistics profile is missing or disabled");
      if (!["wesa", "tiantai", "yuntuo"].includes(profile.provider_id)) throw new Error("Automatic login form support is not yet verified for this logistics provider");
      if (!profile.credential_id || !profile.login_username) throw new Error("This logistics profile has no saved login credentials");
      const credential = this.credentials.read(profile.credential_id);
      password = credential.password;
      if (credential.provider_id !== profile.provider_id || credential.login_username !== profile.login_username) throw new Error("Encrypted credential identity does not match the logistics profile");
      if (this.loginStopping) throw new Error("Logistics login service is stopping");
      signal?.throwIfAborted();
      const args = ["-I", "-B", "-m", "services.agent_cli.logistics.login_worker"];
      const temporaryRoot = join(this.options.dataRoot, "tmp");
      mkdirSync(temporaryRoot, { recursive: true });
      const environment = { ...process.env, ...this.options.environment(), LXE_DATA_ROOT: this.options.dataRoot,
        LXE_AGENT_SESSION_ID: request.session_id, TMP: temporaryRoot, TEMP: temporaryRoot, TMPDIR: temporaryRoot,
        PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
      const stdin = JSON.stringify({ provider_id: profile.provider_id, store_id: request.store_id,
        login_username: credential.login_username, password });
      const execution = this.options.executeLogin ? await this.options.executeLogin(args, environment, stdin)
        : await new Promise<LoginExecution>(resolve => {
          const child = execFile(this.options.pythonPath, args, { cwd: this.options.dataRoot, env: environment,
            timeout: 90_000, maxBuffer: 64 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
            this.loginChildren.delete(child); resolve({ error, stdout, stderr });
          });
          this.loginChildren.add(child);
          child.stdin?.on("error", () => { /* execFile callback retains the actual process failure. */ });
          child.stdin?.end(stdin);
        });
      // The fixed worker returns only evidence. Redact even unexpected process
      // output before returning it, so driver and startup failures cannot leak it.
      let payload: { success?: boolean; error?: unknown } | undefined;
      const stdout = execution.stdout;
      try { payload = JSON.parse(stdout); } catch { /* Retain actual output below. */ }
      if (!payload || typeof payload.success !== "boolean" || (execution.error && payload.success)) {
        throw new Error(safe([execution.error?.message, execution.stderr, `Logistics login response: ${stdout}`].filter(Boolean).join("\n")));
      }
      if (execution.error && !payload.error) throw new Error(safe([execution.error.message, execution.stderr, stdout].join("\n")));
      return publicValue(payload);
    } catch (error) {
      return { success: false, auth_refresh_required: false, error: { code: "desktop_login_failed",
        message: safe(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`) } };
    }
  }
  async save(raw: unknown, expectedRevision: unknown): Promise<DesktopLogisticsSettingsState> {
    const { password, ...input } = validateLogisticsProfileInput(raw);
    const revision = validateLogisticsRevision(expectedRevision);
    try {
      const before = await this.call("snapshot");
      if (before.revision !== revision) throw new Error("Revision conflict: reload logistics settings before saving");
      const existing = before.profiles.find(profile => profile.profile_id === input.profile_id);
      if (input.profile_id && !existing) throw new Error("Logistics profile does not exist; reload settings");
      const username = input.login_username === undefined ? existing?.login_username ?? null : input.login_username;
      const legacyCompany = input.account_name === undefined
        ? existing?.provider_id === input.provider_id ? existing.account_name : null : input.account_name;
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
      const after = await this.call("save", { input: { ...input, account_name: legacyCompany, login_username: username, credential_id: credential }, expected_revision: revision });
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
