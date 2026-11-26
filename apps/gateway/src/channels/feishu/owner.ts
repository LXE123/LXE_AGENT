import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FeishuMessageSnapshot } from "./inbound";

/**
 * The Feishu channel is one person's remote entry to this computer's Agent.
 * The owner is the Feishu account that proved control of this desktop by
 * sending the pairing code shown in Settings; everyone else is refused.
 */

export const FEISHU_PAIRING_TTL_MS = 10 * 60 * 1000;

export const FEISHU_OWNER_REPLIES = Object.freeze({
  paired: "已绑定为所有者。之后私聊或在群里 @我，都会进入同一个个人会话。",
  unpaired: "这个助手还没有绑定所有者。请在 LXE 设置 → 飞书里点「绑定所有者」，再把显示的配对码私聊发给我。",
  notOwner: "这是个人助手，只响应所有者的消息。",
});

export interface FeishuOwnerRecord {
  app_id: string;
  open_id: string;
  paired_at: string;
}

export interface FeishuPairingCode {
  code: string;
  expires_at: string;
}

export interface FeishuOwnerStatus {
  paired: boolean;
  owner_open_id_masked: string;
  paired_at: string;
  pairing: FeishuPairingCode | null;
}

export type FeishuAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "pairing_completed" | "owner_unpaired" | "not_owner"; reply: string };

const text = (value: unknown): string => String(value ?? "").trim();

const maskOpenId = (openId: string): string =>
  openId.length <= 8 ? openId : `${openId.slice(0, 5)}…${openId.slice(-3)}`;

const messageText = (snapshot: FeishuMessageSnapshot): string => {
  if (snapshot.message_type !== "text") return "";
  try {
    const parsed: unknown = JSON.parse(snapshot.content);
    return parsed !== null && typeof parsed === "object" ? text((parsed as { text?: unknown }).text) : "";
  } catch {
    return "";
  }
};

/** Persists the owner next to the Gateway session bindings; open_id is only valid within one Feishu app. */
export class FeishuOwnerFile {
  constructor(readonly path: string) {}

  read(): FeishuOwnerRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`invalid Feishu owner file: ${this.path}`);
    }
    const value = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const record = { app_id: text(value.app_id), open_id: text(value.open_id), paired_at: text(value.paired_at) };
    return record.app_id && record.open_id ? record : undefined;
  }

  write(record: FeishuOwnerRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.feishu-owner.${randomUUID().replaceAll("-", "")}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export interface FeishuOwnerAccessOptions {
  file: FeishuOwnerFile;
  appId: string;
  now?: () => number;
  code?: () => string;
  ttlMs?: number;
}

export class FeishuOwnerAccess {
  private pending: { code: string; expiresAtMs: number } | undefined;
  private readonly now: () => number;
  private readonly code: () => string;
  private readonly ttlMs: number;

  constructor(private readonly options: FeishuOwnerAccessOptions) {
    this.now = options.now ?? Date.now;
    this.code = options.code ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.ttlMs = options.ttlMs ?? FEISHU_PAIRING_TTL_MS;
  }

  status(): FeishuOwnerStatus {
    const owner = this.owner();
    const pairing = this.activePairing();
    return {
      paired: Boolean(owner),
      owner_open_id_masked: owner ? maskOpenId(owner.open_id) : "",
      paired_at: owner?.paired_at ?? "",
      pairing: pairing ? { code: pairing.code, expires_at: new Date(pairing.expiresAtMs).toISOString() } : null,
    };
  }

  /** A new code replaces any earlier one; the current owner keeps access until the code is used. */
  startPairing(): FeishuPairingCode {
    this.pending = { code: this.code(), expiresAtMs: this.now() + this.ttlMs };
    return { code: this.pending.code, expires_at: new Date(this.pending.expiresAtMs).toISOString() };
  }

  decide(snapshot: FeishuMessageSnapshot): FeishuAccessDecision {
    const sender = text(snapshot.sender_open_id);
    const pairing = this.activePairing();
    if (pairing && snapshot.chat_type === "p2p" && messageText(snapshot) === pairing.code) {
      this.options.file.write({ app_id: text(this.options.appId), open_id: sender, paired_at: new Date(this.now()).toISOString() });
      this.pending = undefined;
      return { allowed: false, reason: "pairing_completed", reply: FEISHU_OWNER_REPLIES.paired };
    }
    const owner = this.owner();
    if (!owner) return { allowed: false, reason: "owner_unpaired", reply: FEISHU_OWNER_REPLIES.unpaired };
    if (owner.open_id !== sender) return { allowed: false, reason: "not_owner", reply: FEISHU_OWNER_REPLIES.notOwner };
    return { allowed: true };
  }

  private owner(): FeishuOwnerRecord | undefined {
    const record = this.options.file.read();
    return record && record.app_id === text(this.options.appId) ? record : undefined;
  }

  private activePairing(): { code: string; expiresAtMs: number } | undefined {
    if (this.pending && this.pending.expiresAtMs <= this.now()) this.pending = undefined;
    return this.pending;
  }
}
