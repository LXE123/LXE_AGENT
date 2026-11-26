import { createHash } from "node:crypto";
import type { CredentialSource, DesktopUsageBalance } from "@lxe/desktop-protocol";
import { limitCloudText, sanitizeCloudText } from "./cloud/cloud-errors";

/** Main-process only. Credentials never cross the renderer bridge. */
export interface DeepSeekBalanceCredential {
  source: CredentialSource;
  key: string | null;
}

const empty = (source: CredentialSource | null): DesktopUsageBalance => ({
  status: "unconfigured", source, balances: [], updated_at: null, error: null,
});
const identity = ({ source, key }: DeepSeekBalanceCredential): string =>
  createHash("sha256").update(`${source}:${key ?? ""}`).digest("hex");

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      const remaining = 16_384 - size;
      body += decoder.decode(value.subarray(0, remaining), { stream: true });
      size += value.length;
      if (size > 16_384) return body + decoder.decode() + "… [truncated]";
    }
  } finally {
    await reader.cancel();
  }
}

function parseBalance(body: string): DesktopUsageBalance["balances"] {
  let value;
  try { value = JSON.parse(body); } catch { throw new Error(`Invalid DeepSeek balance response: ${body}`); }
  if (typeof value?.is_available !== "boolean" || !Array.isArray(value.balance_infos)
    || value.balance_infos.length === 0 || value.balance_infos.length > 2
    || value.balance_infos.some((item: Record<string, unknown> | null) => !item
      || (item.currency !== "CNY" && item.currency !== "USD")
      || typeof item.total_balance !== "string" || !/^-?\d{1,16}(?:\.\d{1,8})?$/.test(item.total_balance))) {
    throw new Error(`Invalid DeepSeek balance response: ${body}`);
  }
  const balances = value.balance_infos.map((item: { currency: "CNY" | "USD"; total_balance: string }) => ({
    currency: item.currency, total_balance: item.total_balance,
  }));
  if (new Set(balances.map((item: { currency: string }) => item.currency)).size !== balances.length) {
    throw new Error(`Duplicate currency in DeepSeek balance response: ${body}`);
  }
  return balances;
}

export class DeepSeekBalanceService {
  private cached: { identity: string; value: DesktopUsageBalance } | undefined;
  private pending: { identity: string; promise: Promise<DesktopUsageBalance> } | undefined;

  constructor(
    private readonly credential: () => DeepSeekBalanceCredential,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getBalance(): Promise<DesktopUsageBalance> {
    let credential: DeepSeekBalanceCredential;
    try { credential = this.credential(); } catch (error) {
      this.cached = undefined;
      return { ...empty(null), status: "error", error: this.diagnostic(error) };
    }
    const id = identity(credential);
    if (this.cached?.identity !== id) this.cached = undefined;
    if (!credential.key) return empty(credential.source);
    if (this.pending?.identity === id) return this.pending.promise;
    const promise = this.query(credential, id);
    this.pending = { identity: id, promise };
    try { return await promise; } finally {
      if (this.pending?.promise === promise) this.pending = undefined;
    }
  }

  private diagnostic(error: unknown, key?: string): string {
    const message = error instanceof Error ? error.message : String(error);
    return limitCloudText(sanitizeCloudText(message, key ? [key] : [])
      .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]"), 1500);
  }

  private async query(credential: DeepSeekBalanceCredential, id: string): Promise<DesktopUsageBalance> {
    let value: DesktopUsageBalance;
    try {
      const response = await this.request("https://api.deepseek.com/user/balance", {
        method: "GET",
        headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      const body = await readBody(response);
      if (!response.ok) throw new Error(`DeepSeek balance HTTP ${response.status}: ${body}`);
      value = { status: "ready", source: credential.source, balances: parseBalance(body), updated_at: this.now(), error: null };
    } catch (error) {
      value = { ...(this.cached?.identity === id ? this.cached.value : empty(credential.source)),
        status: "error", error: this.diagnostic(error, credential.key ?? undefined) };
    }
    // Never display or cache an old account's response after a credential switch/revocation.
    try {
      const current = this.credential();
      if (identity(current) !== id) return empty(current.source);
    } catch (error) {
      return { ...empty(null), status: "error", error: this.diagnostic(error, credential.key ?? undefined) };
    }
    if (value.status === "ready") this.cached = { identity: id, value };
    return value;
  }
}
