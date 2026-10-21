import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardTransport, SkillPayload, TeamCatalogReceipt, TeamCatalogSettingsInput, TeamCatalogSnapshot, TeamCatalogState } from "@lxe/desktop-protocol";
import type { SafeStoragePort } from "./config-store/repository";

interface StoredCatalog {
  endpoint: string;
  sourceLabel: string;
  sourceId: string;
  apiKey: string;
  revision: number;
  lastSync: TeamCatalogReceipt | null;
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      const remaining = 16_384 - bytes;
      text += decoder.decode(part.value.subarray(0, remaining), { stream: true });
      bytes += part.value.length;
      if (bytes > 16_384) return text + decoder.decode() + " [truncated]";
    }
  } finally { await reader.cancel(); }
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum || value.includes("\0")) {
    throw new Error(`Invalid ${label} (maximum ${maximum} characters)`);
  }
  return value.trim();
}

export function parseTeamCatalogSettings(value: unknown): TeamCatalogSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog settings");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["endpoint", "sourceLabel", "apiKey"].includes(key))) throw new Error("Unknown catalog setting");
  const url = new URL(boundedText(input.endpoint, "endpoint", 2048));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/openapi/lxe/catalog/sync")) {
    throw new Error("Use the HTTPS /openapi/lxe/catalog/sync endpoint without credentials or query parameters");
  }
  return {
    endpoint: url.href,
    sourceLabel: boundedText(input.sourceLabel, "source label", 80),
    ...(input.apiKey === undefined ? {} : { apiKey: boundedText(input.apiKey, "API key", 4096, true) }),
  };
}

export function projectTeamCatalog(skills: SkillPayload[]): TeamCatalogSnapshot["skills"] {
  if (skills.length > 2000) throw new Error("The directory exceeds the 2000-skill limit");
  const names = new Set<string>();
  return skills.map(skill => {
    const name = boundedText(skill.name, "skill name", 256);
    if (names.has(name)) throw new Error(`Duplicate skill name: ${name}`);
    names.add(name);
    const source = skill.source ?? "repository";
    if (!["repository", "user", "shared"].includes(source)) throw new Error(`Invalid source for ${name}`);
    return {
      name,
      description: boundedText(skill.description, "skill description", 16000, true),
      type: boundedText(skill.type, "skill type", 128),
      source,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** Electron owns this outbound integration and its encrypted configuration. */
export class TeamCatalogSyncService {
  private readonly directory: string;
  private readonly path: string;
  private pending = false;

  constructor(dataRoot: string, private readonly secure: SafeStoragePort, private readonly dashboard: DashboardTransport, private readonly request: typeof fetch = fetch) {
    this.directory = join(dataRoot, "config");
    this.path = join(this.directory, "team-catalog.bin");
  }

  private read(): StoredCatalog {
    let bytes: Buffer;
    try { bytes = readFileSync(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { endpoint: "", sourceLabel: "LXE 工作站", sourceId: "", apiKey: "", revision: 0, lastSync: null };
    }
    this.requireEncryption();
    const value: StoredCatalog = JSON.parse(this.secure.decryptString(bytes));
    parseTeamCatalogSettings({ endpoint: value.endpoint, sourceLabel: value.sourceLabel, apiKey: value.apiKey });
    if (!/^[0-9a-f-]{36}$/i.test(value.sourceId) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid stored catalog identity");
    return value;
  }

  private requireEncryption(): void {
    if (!this.secure.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system");
  }

  private write(value: StoredCatalog): void {
    this.requireEncryption();
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, this.secure.encryptString(JSON.stringify(value)), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  state(): TeamCatalogState {
    const value = this.read();
    return { endpoint: value.endpoint, sourceLabel: value.sourceLabel, sourceId: value.sourceId, configured: !!value.apiKey, syncing: this.pending, lastSync: value.lastSync };
  }

  save(input: TeamCatalogSettingsInput): TeamCatalogState {
    if (this.pending) throw new Error("Wait for the current synchronization to finish");
    const next = parseTeamCatalogSettings(input);
    const previous = this.read();
    if (!next.apiKey && next.endpoint !== previous.endpoint) throw new Error("Enter an API key when changing the destination");
    const apiKey = next.apiKey || previous.apiKey;
    if (!apiKey) throw new Error("Enter the sync API key");
    this.write({ ...previous, ...next, sourceId: previous.sourceId || randomUUID(), apiKey: apiKey, lastSync: previous.endpoint === next.endpoint ? previous.lastSync : null });
    return this.state();
  }

  async sync(): Promise<TeamCatalogState> {
    if (this.pending) throw new Error("A directory synchronization is already running");
    const value = this.read();
    if (!value.apiKey) throw new Error("Configure the team directory before syncing");
    this.pending = true;
    try {
      // The runtime API applies current permissions, enabled state and name resolution.
      const catalog = await this.dashboard.call({ operation: "skills.list", input: {} });
      const skills = projectTeamCatalog(catalog.items);
      if (catalog.total !== skills.length) throw new Error("The runtime returned an incomplete skill directory");
      if (value.revision >= 2_147_483_647) throw new Error("Catalog revision exhausted");
      value.revision += 1;
      this.write(value);
      const snapshot: TeamCatalogSnapshot = { schemaVersion: 1, sourceId: value.sourceId, sourceLabel: value.sourceLabel, revision: value.revision, collectedAt: new Date().toISOString(), skills };
      const body = JSON.stringify(snapshot);
      if (Buffer.byteLength(body) > 900_000) throw new Error("The skill directory exceeds the 900 KB upload limit");
      const response = await this.request(value.endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${value.apiKey}` }, body,
      });
      const raw = await readResponse(response);
      if (!response.ok) {
        const detail = raw.replaceAll(value.apiKey, "[redacted]");
        throw new Error(`Catalog synchronization HTTP ${response.status}: ${detail.slice(0, 2000)}${detail.length > 2000 ? " [truncated]" : ""}`);
      }
      const receipt: TeamCatalogReceipt = JSON.parse(raw);
      if (receipt.sourceId !== value.sourceId || receipt.revision !== value.revision || receipt.skillCount !== skills.length || typeof receipt.receivedAt !== "string" || !Number.isFinite(Date.parse(receipt.receivedAt))) {
        throw new Error(`The directory server returned an invalid synchronization receipt: ${raw.slice(0, 2000)}${raw.length > 2000 ? " [truncated]" : ""}`);
      }
      value.lastSync = { sourceId: receipt.sourceId, revision: receipt.revision, skillCount: receipt.skillCount, receivedAt: receipt.receivedAt };
      this.write(value);
    } catch (error) {
      const message = error instanceof Error
        ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
        : String(error);
      throw new Error(message.replaceAll(value.apiKey, "[redacted]"));
    } finally { this.pending = false; }
    return this.state();
  }
}
