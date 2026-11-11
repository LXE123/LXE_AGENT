import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { OAuthError, type StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import { sanitizeLogValueWithPolicy } from "@lxe/core";
import { McpLoginRequired } from "@lxe/runtime";
import { renewMcpGrant, type McpGrant, type McpClientRegistrationStore } from "./mcp-oauth";

type McpAuthRecord = Omit<McpGrant, "access_token"> & {
  access_token?: string;
};

function sameClient(a: StoredOAuthClientInformation | undefined, b: StoredOAuthClientInformation): boolean {
  return a?.client_id === b.client_id && a?.issuer === b.issuer && a?.client_secret === b.client_secret;
}

export class McpAuthStore {
  private readonly path: string;
  constructor(dataRoot: string) { this.path = join(dataRoot, "config", "mcp-auth.json"); }

  private read(): McpAuthRecord[] {
    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // A parser error can quote the input, which contains tokens.
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("Invalid JSON in mcp-auth.json"); }
    if (!Array.isArray(value) || !value.every(g => g && typeof g.name === "string" && typeof g.url === "string" &&
        (g.access_token === undefined || typeof g.access_token === "string") &&
        (g.registration === undefined || (typeof g.registration?.client_id === "string" &&
          typeof g.registration.issuer === "string" && (g.registration.redirect_uris === undefined ||
            (Array.isArray(g.registration.redirect_uris) && g.registration.redirect_uris.every((uri: unknown) => typeof uri === "string"))))) &&
        (g.access_token !== undefined || g.registration !== undefined))) {
      throw new Error("Invalid credential record in mcp-auth.json");
    }
    return value;
  }

  get(name: string, url: string): McpGrant | undefined {
    const record = this.read().find(grant => grant.name === name && grant.url === url);
    return record?.access_token !== undefined ? record as McpGrant : undefined;
  }

  clientRegistration(name: string, url: string): McpClientRegistrationStore {
    return {
      load: () => this.read().find(g => g.name === name && g.url === url)?.registration,
      save: (registration, signal) => this.locked(() => {
        signal.throwIfAborted();
        const current = this.read().find(g => g.name === name && g.url === url);
        // Tokens belong to the registered client. A replacement starts without them.
        this.write({ ...(current && sameClient(current.registration, registration) ? current : { name, url }), registration });
      }),
      invalidate: (client, scope) => this.locked(() => {
        const records = this.read();
        const current = records.find(g => g.name === name && g.url === url);
        // A late failure from one login must not erase another process's new registration.
        if (!current?.registration || !sameClient(current.registration, client)) return;
        const others = records.filter(g => g !== current);
        this.writeAll(scope === "client" ? others : [...others, { name, url, registration: current.registration }]);
      }),
    };
  }

  private async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, { realpath: false, stale: 30_000,
      retries: { retries: 100, factor: 1.3, minTimeout: 15, maxTimeout: 350, randomize: true } });
    try { return await operation(); } finally { await release(); }
  }

  private writeAll(grants: McpAuthRecord[]): void {
    const temp = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify(grants, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }

  private write(grant: McpAuthRecord): void {
    const others = this.read().filter(g => g.name !== grant.name || g.url !== grant.url);
    this.writeAll([...others, grant]);
  }

  async forget(name: string, url: string): Promise<boolean> {
    return this.locked(() => {
      const grants = this.read();
      const remaining = grants.filter(g => g.name !== name || g.url !== url);
      if (remaining.length === grants.length) return false;
      this.writeAll(remaining);
      return true;
    });
  }

  async save(grant: McpGrant, signal?: AbortSignal): Promise<void> {
    await this.locked(() => {
      signal?.throwIfAborted();
      const registration = this.clientRegistration(grant.name, grant.url).load();
      if (grant.registration && !sameClient(registration, grant.registration)) {
        throw new Error("MCP client registration changed during sign-in; sign in again");
      }
      this.write({ ...grant, ...(registration && { registration }) });
    });
  }

  async token(name: string, url: string, rejected?: string): Promise<string | undefined> {
    const grant = this.get(name, url);
    if (!grant?.renewal) return grant?.access_token;
    const due = rejected !== undefined ? grant.access_token === rejected
      : grant.expires_at !== undefined && grant.expires_at <= Date.now() + 30_000;
    if (!due) return grant.access_token;
    return this.locked(async () => {
      const current = this.get(name, url);
      if (current?.access_token !== grant.access_token || !current?.renewal ||
          current.renewal.refresh_token !== grant.renewal?.refresh_token || current.expires_at !== grant.expires_at) {
        return current?.access_token;
      }
      let refreshed: McpGrant;
      try { refreshed = await renewMcpGrant(current); }
      catch (error) {
        const needsLogin = error instanceof OAuthError && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code);
        if (needsLogin) {
          const { renewal, ...remaining } = current;
          const record: McpAuthRecord = remaining;
          if (error.code !== "invalid_grant" && sameClient(record.registration, renewal!.client)) delete record.registration;
          this.write(record);
        }
        // On early refresh failure the resource server can still accept the access token.
        if (rejected === undefined) return current.access_token;
        let message = error instanceof OAuthError ? error.code + ": " + error.message : error instanceof Error ? error.message : String(error);
        for (const secret of [current.access_token, current.renewal.refresh_token, current.renewal.client.client_secret]) {
          if (secret) message = message.replaceAll(secret, "[redacted]");
        }
        const failure = new Error(String(sanitizeLogValueWithPolicy(message, { maxString: 8192 })));
        if (needsLogin) throw new McpLoginRequired({ url }, failure);
        throw failure;
      }
      this.write(refreshed);
      return refreshed.access_token;
    });
  }
}
