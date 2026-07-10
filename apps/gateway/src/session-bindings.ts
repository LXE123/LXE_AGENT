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
  user_id_alt?: unknown;
  user_name?: unknown;
  chat_name?: unknown;
  thread_id?: unknown;
  message_id?: unknown;
  root_id?: unknown;
  parent_id?: unknown;
  is_bot?: unknown;
  extra?: unknown;
}

export class SessionSource {
  private constructor(
    readonly platform: string,
    readonly chat_id: string,
    readonly chat_type: string,
    readonly user_id: string,
    readonly user_id_alt: string,
    readonly user_name: string,
    readonly chat_name: string,
    readonly thread_id: string,
    readonly message_id: string,
    readonly root_id: string,
    readonly parent_id: string,
    readonly is_bot: boolean,
    readonly extra: JsonRecord,
  ) {}

  static from(value: SessionSourceData | null | undefined): SessionSource {
    const raw = value ?? {};
    return new SessionSource(
      clean(raw.platform),
      clean(raw.chat_id),
      normalizeChatType(raw.chat_type),
      clean(raw.user_id),
      clean(raw.user_id_alt),
      clean(raw.user_name),
      clean(raw.chat_name),
      clean(raw.thread_id),
      clean(raw.message_id),
      clean(raw.root_id),
      clean(raw.parent_id),
      Boolean(raw.is_bot),
      raw.extra !== null && typeof raw.extra === "object" && !Array.isArray(raw.extra)
        ? { ...(raw.extra as JsonRecord) }
        : {},
    );
  }

  get userKey(): string {
    return this.user_id_alt || this.user_id;
  }

  get sessionKey(): string {
    if (!this.platform) throw new Error("session source platform required");
    if (!this.chat_id) throw new Error("session source chat_id required");
    const prefix = `agent:main:${this.platform}`;
    if (this.chat_type === "dm") return `${prefix}:dm:${this.chat_id}`;
    if (this.chat_type === "group") {
      if (this.thread_id) return `${prefix}:group:${this.chat_id}:${this.thread_id}`;
      if (!this.userKey) throw new Error("group session source user_id or user_id_alt required");
      return `${prefix}:group:${this.chat_id}:${this.userKey}`;
    }
    return `${prefix}:${this.chat_type}:${this.chat_id}`;
  }

  toJSON(): JsonRecord {
    const data: JsonRecord = {
      platform: this.platform,
      chat_id: this.chat_id,
      chat_type: this.chat_type,
      user_id: this.user_id,
      user_id_alt: this.user_id_alt,
      user_name: this.user_name,
      chat_name: this.chat_name,
      thread_id: this.thread_id,
      message_id: this.message_id,
      root_id: this.root_id,
      parent_id: this.parent_id,
      is_bot: this.is_bot,
      extra: { ...this.extra },
    };
    return Object.fromEntries(
      Object.entries(data).filter(
        ([key, value]) => value !== null && value !== "" && !(key === "extra" && Object.keys(value as object).length === 0),
      ),
    );
  }
}

export interface SessionBindingEntry {
  session_key: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  origin: JsonRecord;
  platform: string;
  chat_type: string;
  resume_pending: boolean;
  suspended: boolean;
}

interface StoreOptions {
  now?: () => string;
  id?: () => string;
}

const parseEntry = (value: JsonRecord): SessionBindingEntry => {
  const origin =
    value.origin !== null && typeof value.origin === "object" && !Array.isArray(value.origin)
      ? { ...(value.origin as JsonRecord) }
      : {};
  return {
    session_key: clean(value.session_key),
    session_id: clean(value.session_id),
    created_at: clean(value.created_at),
    updated_at: clean(value.updated_at),
    origin,
    platform: clean(value.platform ?? origin.platform),
    chat_type: normalizeChatType(value.chat_type ?? origin.chat_type),
    resume_pending: Boolean(value.resume_pending),
    suspended: Boolean(value.suspended),
  };
};

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
      origin: source.toJSON(),
      platform: source.platform,
      chat_type: source.chat_type,
      resume_pending: existing?.resume_pending ?? false,
      suspended: existing?.suspended ?? false,
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
}
