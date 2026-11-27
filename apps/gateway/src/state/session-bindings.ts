import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

const clean = (value: unknown): string => String(value ?? "").trim();
const normalizeChatType = (value: unknown): string => {
  const text = clean(value).toLowerCase();
  if (["p2p", "private", "dm", "direct"].includes(text)) return "dm";
  if (["group", "chat"].includes(text)) return "group";
  if (text === "channel" || text === "thread") return text;
  return text || "dm";
};

export interface SessionSourceData {
  platform?: unknown;
  chat_id?: unknown;
  chat_type?: unknown;
  user_id?: unknown;
  user_name?: unknown;
  message_id?: unknown;
  extra?: unknown;
}

/** Where one message came from; every message on a channel lands in the same personal session. */
export class SessionSource {
  private constructor(
    readonly platform: string,
    readonly chat_id: string,
    readonly chat_type: string,
    readonly user_id: string,
    readonly user_name: string,
    readonly message_id: string,
    readonly extra: JsonRecord,
  ) {}

  static from(value: SessionSourceData | null | undefined): SessionSource {
    const raw = value ?? {};
    return new SessionSource(
      clean(raw.platform),
      clean(raw.chat_id),
      normalizeChatType(raw.chat_type),
      clean(raw.user_id),
      clean(raw.user_name),
      clean(raw.message_id),
      raw.extra !== null && typeof raw.extra === "object" && !Array.isArray(raw.extra)
        ? { ...(raw.extra as JsonRecord) }
        : {},
    );
  }

  /**
   * A channel is one person's remote entry to the Agent, so every chat on it
   * shares one session. Replies still go back to each message's own chat
   * through its response route.
   */
  get sessionKey(): string {
    if (!this.platform) throw new Error("session source platform required");
    return `agent:main:${this.platform}:personal`;
  }

  toJSON(): JsonRecord {
    const data: JsonRecord = {
      platform: this.platform,
      chat_id: this.chat_id,
      chat_type: this.chat_type,
      user_id: this.user_id,
      user_name: this.user_name,
      message_id: this.message_id,
      extra: { ...this.extra },
    };
    return Object.fromEntries(
      Object.entries(data).filter(
        ([key, value]) => value !== "" && !(key === "extra" && Object.keys(value as object).length === 0),
      ),
    );
  }
}

/** Maps a channel's session key to the Agent session it currently uses. */
export interface SessionBindingEntry {
  session_key: string;
  session_id: string;
  created_at: string;
  updated_at: string;
}

interface StoreOptions {
  now?: () => string;
  id?: () => string;
}

const parseEntry = (value: JsonRecord): SessionBindingEntry => ({
  session_key: clean(value.session_key),
  session_id: clean(value.session_id),
  created_at: clean(value.created_at),
  updated_at: clean(value.updated_at),
});

export class SessionBindingStore {
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(readonly path: string, options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => randomUUID().replaceAll("-", ""));
  }

  loadAll(): Record<string, SessionBindingEntry> {
    let rawText: string;
    try {
      rawText = readFileSync(this.path, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return {};
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawText || "{}");
    } catch {
      throw new Error(`invalid sessions.json: ${this.path}`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`sessions.json must be a JSON object: ${this.path}`);
    }
    const entries: Record<string, SessionBindingEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = parseEntry(value as JsonRecord);
      const sessionKey = entry.session_key || clean(key);
      if (sessionKey && entry.session_id) entries[sessionKey] = { ...entry, session_key: sessionKey };
    }
    return entries;
  }

  ensureUsable(): void {
    this.loadAll();
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true });
    const probe = join(parent, `.sessions-write-probe.${randomUUID().replaceAll("-", "")}.tmp`);
    try {
      writeFileSync(probe, "{}\n", "utf8");
    } finally {
      rmSync(probe, { force: true });
    }
  }

  saveAll(entries: Readonly<Record<string, SessionBindingEntry>>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted: Record<string, SessionBindingEntry> = {};
    for (const key of Object.keys(entries).sort()) {
      const entry = entries[key];
      if (key && entry?.session_id) sorted[key] = entry;
    }
    const temporary = join(
      dirname(this.path),
      `.${this.path.split(/[\\/]/).at(-1)}.${randomUUID().replaceAll("-", "")}.tmp`,
    );
    try {
      writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  get(sessionKey: string): SessionBindingEntry | undefined {
    return this.loadAll()[clean(sessionKey)];
  }

  bind(source: SessionSource, sessionId: string): SessionBindingEntry {
    const sessionKey = source.sessionKey;
    const entries = this.loadAll();
    const existing = entries[sessionKey];
    const now = this.now();
    const entry: SessionBindingEntry = {
      session_key: sessionKey,
      session_id: clean(sessionId),
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    entries[sessionKey] = entry;
    this.saveAll(entries);
    return entry;
  }

  getOrCreate(source: SessionSource): SessionBindingEntry {
    const existing = this.get(source.sessionKey);
    return existing?.session_id ? existing : this.bind(source, this.id());
  }

  rotate(source: SessionSource): SessionBindingEntry {
    return this.bind(source, this.id());
  }

  removeSession(sessionId: string): SessionBindingEntry[] {
    const safe = clean(sessionId);
    const entries = this.loadAll();
    const removed = Object.values(entries).filter((entry) => entry.session_id === safe);
    if (removed.length === 0) return [];
    for (const entry of removed) delete entries[entry.session_key];
    this.saveAll(entries);
    return removed;
  }

  restore(entriesToRestore: readonly SessionBindingEntry[]): void {
    if (entriesToRestore.length === 0) return;
    const entries = this.loadAll();
    for (const entry of entriesToRestore) {
      if (entry.session_key && entry.session_id) entries[entry.session_key] = { ...entry };
    }
    this.saveAll(entries);
  }
}
