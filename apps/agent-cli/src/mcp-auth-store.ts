import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { OAuthError } from "@modelcontextprotocol/client";
import { sanitizeLogValueWithPolicy } from "@lxe/core";
import { renewMcpGrant, type McpGrant } from "./mcp-oauth";

export class McpAuthStore {
  private readonly path: string;
  constructor(dataRoot: string) { this.path = join(dataRoot, "config", "mcp-auth.json"); }

  private read(): McpGrant[] {
    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // A parser error can quote the input, which contains tokens.
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("Invalid JSON in mcp-auth.json"); }
    if (!Array.isArray(value) || !value.every(g => g && typeof g.name === "string" && typeof g.url === "string" && typeof g.access_token === "string")) {
      throw new Error("Invalid credential record in mcp-auth.json");
    }
    return value;
  }

  get(name: string, url: string): McpGrant | undefined {
    return this.read().find(grant => grant.name === name && grant.url === url);
  }

  private async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, { realpath: false, stale: 30_000,
      retries: { retries: 100, factor: 1.3, minTimeout: 15, maxTimeout: 350, randomize: true } });
    try { return await operation(); } finally { await release(); }
  }

  private write(grant: McpGrant): void {
    const grants = this.read().filter(g => g.name !== grant.name || g.url !== grant.url);
    const temp = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify([...grants, grant], null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }

  async save(grant: McpGrant, signal?: AbortSignal): Promise<void> {
    await this.locked(() => {
      signal?.throwIfAborted();
      this.write(grant);
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
        if (error instanceof OAuthError && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)) {
          const { renewal, ...remaining } = current;
          this.write(remaining);
        }
        // On early refresh failure the resource server can still accept the access token.
        if (rejected === undefined) return current.access_token;
        let message = error instanceof OAuthError ? error.code + ": " + error.message : error instanceof Error ? error.message : String(error);
        for (const secret of [current.access_token, current.renewal.refresh_token, current.renewal.client.client_secret]) {
          if (secret) message = message.replaceAll(secret, "[redacted]");
        }
        throw new Error(String(sanitizeLogValueWithPolicy(message, { maxString: 8192 })));
      }
      this.write(refreshed);
      return refreshed.access_token;
    });
  }
}
