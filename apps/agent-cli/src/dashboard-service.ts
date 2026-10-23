import { execDisplayUpdate } from "./exec-display";
import { withManagedModels, managedCredentialFor, resolveWorkspaceContext, type ManagedLlmState, type ManagedTarget } from "@lxe/core";
import {
  existsSync,
  accessSync,
  constants,
  readFileSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  DashboardRpcError,
  type AgentDashboardRpcCall,
  type AgentDashboardRpcHandlers,
  type AgentDashboardRpcOperation,
  type DashboardRpcResult,
  type DashboardRpcSpec,
} from "@lxe/desktop-protocol";
import type { JsonObject } from "@lxe/protocol";
import { createLogger, loadLlmProviderCatalog, normalizeProviderKey, type LlmProviderSpec } from "@lxe/core";
import {
  InvalidTranscriptCursorError,
  mcpServerPrefix,
  normalizeThinkingEffort,
  providerPreferencePatch,
  readProviderPreference,
  SkillCatalog,
  WorkspaceFileSearch, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  UserSkillFiles,
  type McpConfig,
  type RuntimeProviderManager,
  type RuntimeModelSelection,
  type SkillManifest,
  type SqliteRuntimeStore,
  type ToolRegistry,
  type UserQuestionService,
  type SessionTitleService,
  type PermissionApprovalService,
} from "@lxe/runtime";

type Environment = Record<string, string | undefined>;

/** Agent-process dependencies required by the Dashboard query service. */
interface DashboardServiceOptions {
  questions?: UserQuestionService;
  sessionTitles?: SessionTitleService;
  approvals?: PermissionApprovalService;
  onPermissionChanged?: (sessionId: string) => Promise<void> | void;
  /** Writable desktop/source state. */
  stateRoot: string;
  /** Read-only provider schemas and auth profile metadata. */
  llmConfigRoot: string;
  /** Read-only repository-owned Skill directory. */
  skillsRoot: string;
  /** User-owned Skill directory. */
  userSkillsRoot: string;
  sharedSkillsRoot?: string | false;
  environment: Environment;
  store: SqliteRuntimeStore;
  tools: ToolRegistry;
  mcpConfig: McpConfig;
  execSnapshots?: (sessionId: string) => JsonObject[];
  terminateSession?: (sessionId: string) => Promise<void> | void;
  setMcpEnabled?: (serverName: string, enabled: boolean) => Promise<void> | void;
  mcpStatus?: (serverName: string) => {
    connected: boolean;
    error: string;
    toolCount?: number;
    tools?: Array<{ rawName: string; modelName: string }>;
  };
  providerManager?: RuntimeProviderManager;
  managedLlmState?: () => ManagedLlmState | undefined;
  skillCatalog?: SkillCatalog;
  allowedSkillTypes?: ReadonlySet<string>;
  reloadWorkspace?: (sessionId: string) => Promise<JsonObject>;
}

const text = (value: unknown): string => String(value ?? "").trim();
const optionalFlag = (value: unknown): boolean | undefined => {
  const normalized = text(value).toLowerCase();
  if (!normalized) return undefined;
  return ["1", "true", "yes", "on"].includes(normalized);
};
const integer = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  return value === undefined ? fallback : Math.max(minimum, Math.min(Math.trunc(value), maximum));
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const DASHBOARD_TOOL_RESULT_PREVIEW_BYTES = 32 * 1024;
export const DASHBOARD_TOOL_RESULT_PAGE_PREVIEW_BYTES = 256 * 1024;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const utf8Prefix = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return "";
  if (utf8Bytes(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  }
  return value.slice(0, end);
};

const utf8Suffix = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return "";
  if (utf8Bytes(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(value.length - middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let start = value.length - low;
  if (start > 0 && start < value.length) {
    const first = value.charCodeAt(start);
    if (first >= 0xDC00 && first <= 0xDFFF) start += 1;
  }
  return value.slice(start);
};

const toolResultText = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "", null, 2);
  } catch {
    return String(value ?? "");
  }
};

const truncateToolResult = (
  value: unknown,
  maximumBytes: number,
): { content: string; originalBytes: number; previewBytes: number } => {
  const original = toolResultText(value);
  const originalBytes = utf8Bytes(original);
  if (originalBytes <= maximumBytes) {
    return { content: original, originalBytes, previewBytes: originalBytes };
  }
  const marker = `\n… [Dashboard preview truncated; original ${originalBytes} bytes] …\n`;
  const markerBytes = utf8Bytes(marker);
  if (maximumBytes <= markerBytes) {
    const content = utf8Prefix(marker, maximumBytes);
    return { content, originalBytes, previewBytes: utf8Bytes(content) };
  }
  const contentBytes = maximumBytes - markerBytes;
  const head = utf8Prefix(original, Math.floor(contentBytes * 0.75));
  const tail = utf8Suffix(original, contentBytes - utf8Bytes(head));
  const content = `${head}${marker}${tail}`;
  return { content, originalBytes, previewBytes: utf8Bytes(content) };
};

export const dashboardSessionDetailPreview = (
  detail: JsonObject,
  execSnapshots: readonly JsonObject[] = [],
): JsonObject => {
  const preview = structuredClone(detail);
  const messages = Array.isArray(preview.messages) ? preview.messages : [];
  const results: Array<Record<string, unknown>> = [];
  const resultTurns = new Map<Record<string, unknown>, string>();
  for (const message of messages) {
    const record = object(message);
    if (!Array.isArray(record.content)) continue;
    for (const candidate of record.content) {
      const block = object(candidate);
      if (block.type === "tool_result") {
        results.push(block);
        resultTurns.set(block, text(object(record.turn).turn_id));
      }
    }
  }
  let remainingBytes = DASHBOARD_TOOL_RESULT_PAGE_PREVIEW_BYTES;
  for (let index = 0; index < results.length; index += 1) {
    const block = results[index]!;
    const remainingResults = results.length - index;
    const allocation = Math.min(
      DASHBOARD_TOOL_RESULT_PREVIEW_BYTES,
      Math.max(0, Math.floor(remainingBytes / remainingResults)),
    );
    const result = truncateToolResult(block.content, allocation);
    remainingBytes = Math.max(0, remainingBytes - result.previewBytes);
    if (result.originalBytes <= result.previewBytes) continue;
    block.content = result.content;
    block.dashboard_truncation = {
      truncated: true,
      original_bytes: result.originalBytes,
      preview_bytes: result.previewBytes,
    };
  }
  const taskKey = (turnId: string, callId: string) => JSON.stringify([turnId, callId]);
  const updates = new Map(execSnapshots.map(execDisplayUpdate).filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map(update => [taskKey(update.task.origin_turn_id, update.tool_call_id), update]));
  for (const block of results) {
    const update = updates.get(taskKey(resultTurns.get(block) ?? "", text(block.tool_call_id)));
    if (!update) continue;
    block.display_status = update.step.status;
    block.content = (update.step.error_block ?? update.step.result_block)?.content ?? "";
    if (update.step.status === "error") block.is_error = true;
    else delete block.is_error;
    delete block.dashboard_truncation;
  }
  return preview;
};

const safeChild = (root: string, rawPath: string, extension?: string): string | undefined => {
  const requested = rawPath.replaceAll("\\", "/");
  if (!requested || requested.startsWith("/") || requested.startsWith("~") || requested.includes(":")) return undefined;
  const parts = requested.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  if (extension && extname(requested).toLowerCase() !== extension) return undefined;
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...parts);
  const relation = relative(rootPath, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) return undefined;
  return candidate;
};

const loadJson = (path: string): Record<string, unknown> => object(JSON.parse(readFileSync(path, "utf8")));

function rpcError(code: ConstructorParameters<typeof DashboardRpcError>[0], message: string): never {
  throw new DashboardRpcError(code, message);
}

export class DashboardService {
  private readonly skillCatalog: SkillCatalog;
  private readonly userSkillFiles: UserSkillFiles;
  private readonly handlers: AgentDashboardRpcHandlers = {
    "sessions.turn.lookup": input => this.options.store.lookupTurn(input.session_id, input.turn_id),
    "sessions.create": input => {
      const registration = this.options.store.getWorkspace(input.workspace_id) ?? rpcError("not_found", "workspace not found");
      const workspace = resolveWorkspaceContext(registration.directory);
      accessSync(workspace.directory, constants.R_OK | constants.W_OK | constants.X_OK);
      return this.options.store.createBlankSession(workspace, input.workspace_id) as DashboardRpcResult<"sessions.create">;
    },
    "sessions.workspaces": () => this.options.store.listSessionWorkspaces(),
    "workspaces.register": input => {
      const { directory } = resolveWorkspaceContext(input.directory);
      accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
      return this.options.store.registerWorkspace(directory);
    },
    "workspaces.rename": input => this.options.store.renameWorkspace(input.workspace_id, input.display_name)
      ?? rpcError("not_found", "workspace not found"),
    "workspaces.delete": input => {
      if (!this.options.store.deleteWorkspace(input.workspace_id)) rpcError("not_found", "workspace not found");
      return { deleted: true };
    },
    "sessions.permission.set": async input => {
      this.options.store.setSessionPermissionMode(input.session_id, input.permission_mode);
      const permission_mode = this.options.store.getSessionPermissionMode(input.session_id);
      await this.options.onPermissionChanged?.(input.session_id);
      return { session_id: input.session_id, permission_mode };
    },
    "sessions.approvals": () => ({ items: this.options.approvals?.snapshot() ?? [] }),
    "sessions.approval.decide": input => {
      if (!this.options.approvals) return rpcError("unavailable", "Single-operation approval is unavailable");
      return this.options.approvals.decide(input);
    },
    "sessions.questions": () => ({ items: this.options.questions?.snapshot() ?? [] }),
    "sessions.answer": input => {
      if (!this.options.questions) return rpcError("unavailable", "User questions are unavailable");
      return this.options.questions.submit(input);
    },
    "sessions.execTasks": input => ({ items: (this.options.execSnapshots?.(input.session_id) ?? [])
      .map(execDisplayUpdate).filter((item): item is NonNullable<typeof item> => Boolean(item)) }),
    "sessions.list": (input) => this.sessions(input) as DashboardRpcResult<"sessions.list">,
    "sessions.detail": (input) => this.session(input) as Promise<DashboardRpcResult<"sessions.detail">>,
    "sessions.rename": async input => {
      if (!this.options.sessionTitles) return rpcError("unavailable", "Session titles are unavailable");
      await this.options.sessionTitles.rename(input.session_id, input.title);
      const session = this.options.store.sessionMetadata(input.session_id);
      if (!session) return rpcError("not_found", "session not found");
      return session as DashboardRpcResult<"sessions.rename">;
    },
    "sessions.pin": (input) => this.pinSession(input) as DashboardRpcResult<"sessions.pin">,
    "sessions.delete": (input) => this.deleteSession(input) as Promise<DashboardRpcResult<"sessions.delete">>,
    "sessions.files.candidates": input => this.fileCandidates(input.session_id, input.query),
    "sessions.workspace.reload": (input) => this.reloadWorkspace(input),
    "skills.user.list": () => this.listPayload(this.userSkillFiles.list(this.skillOptions())) as DashboardRpcResult<"skills.user.list">,
    "skills.user.content": input => this.userSkillFiles.content(input.id, this.skillOptions(), input.path),
    "skills.user.setEnabled": input => this.userSkillFiles.setEnabled(input.id, input.version, input.enabled, this.skillOptions()),
    "skills.user.delete": input => this.userSkillFiles.delete(input.id, input.version),
    "skills.list": async input => this.listPayload((await this.sessionSkills(input.session_id)).map(manifest => this.skillPayload(manifest))) as DashboardRpcResult<"skills.list">,
    "skills.content": async input => {
      const skill = (await this.sessionSkills(input.session_id)).find(item => item.name === input.name);
      if (!skill) rpcError("not_found", "skill not found");
      return this.skillPayload(skill, true) as DashboardRpcResult<"skills.content">;
    },
    "skills.reference": (input) => this.skillReference(input.name, input.path) as DashboardRpcResult<"skills.reference">,
    "toolsets.list": () => this.listPayload(this.toolsets()) as DashboardRpcResult<"toolsets.list">,
    "mcp.servers.list": () => this.mcpServers() as DashboardRpcResult<"mcp.servers.list">,
    "mcp.servers.update": (input) => this.updateMcp(input) as Promise<DashboardRpcResult<"mcp.servers.update">>,
    "stats.overview": (input) => this.overview(input.days) as DashboardRpcResult<"stats.overview">,
    "stats.skills.list": (input) => {
      const days = this.days(input.days);
      return { ...this.listPayload(this.options.store.skillUsageStats(days)), days } as DashboardRpcResult<"stats.skills.list">;
    },
    "stats.skills.detail": (input) => {
      const days = this.days(input.days);
      return { ...this.options.store.skillUsageDetail(input.name, days), days } as DashboardRpcResult<"stats.skills.detail">;
    },
    "stats.tools.list": (input) => {
      const days = this.days(input.days);
      return { ...this.listPayload(this.options.store.toolUsageStats(days)), days } as DashboardRpcResult<"stats.tools.list">;
    },
    "models.list": () => this.listPayload(this.models()) as DashboardRpcResult<"models.list">,
    "models.current": (input) => (input.session_id ? this.sessionCurrentModel(input.session_id) : this.currentModel()) as DashboardRpcResult<"models.current"> | Promise<DashboardRpcResult<"models.current">>,
    "models.update": (input) => this.updateModel(input) as Promise<DashboardRpcResult<"models.update">>,
    "models.thinking.update": (input) => this.updateThinking(input) as Promise<DashboardRpcResult<"models.thinking.update">>,
  };

  constructor(private readonly options: DashboardServiceOptions) {
    this.skillCatalog = options.skillCatalog ?? new SkillCatalog(options.stateRoot, options.userSkillsRoot, {
      repositorySkillsRoot: options.skillsRoot,
      ...(options.sharedSkillsRoot === undefined ? {} : { sharedSkillsRoot: options.sharedSkillsRoot }),
      statePath: join(options.stateRoot, "config", "skill-states.local.json"),
    excludedRoots: [join(options.stateRoot, "trash", "skills")],
    });
    this.userSkillFiles = new UserSkillFiles(this.skillCatalog, options.stateRoot);
  }

  async call<O extends AgentDashboardRpcOperation>(
    call: AgentDashboardRpcCall<O>,
  ): Promise<DashboardRpcResult<O>> {
    if (["skills.list", "skills.content", "skills.reference", "skills.user.list", "skills.user.content"].includes(call.operation)) {
      await this.skillCatalog.refreshForUse();
    }
    const handler = this.handlers[call.operation] as (
      input: DashboardRpcSpec[O]["input"],
    ) => DashboardRpcResult<O> | Promise<DashboardRpcResult<O>>;
    return handler(call.input);
  }

  private listPayload(items: unknown[]): { items: unknown[]; total: number } {
    return { items, total: items.length };
  }

  private sessions(input: DashboardRpcSpec["sessions.list"]["input"]): ReturnType<SqliteRuntimeStore["listSessions"]> {
    return this.options.store.listSessions({
      limit: integer(input.limit, 50, 1, 200),
      offset: integer(input.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      query: input.query ?? "",
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
    });
  }

  private pinSession(input: DashboardRpcSpec["sessions.pin"]["input"]): JsonObject {
    const session = this.options.store.pinSession(input.session_id, input.pinned);
    if (!session) return rpcError("not_found", "session not found");
    return session;
  }

  private readonly fileSearches = new Map<string, { root: string; search: WorkspaceFileSearch; query?: AbortController }>();
  invalidateFileCandidates(session: string): void { this.fileSearches.get(session)?.search.invalidate(); }
  releaseFileCandidates(session: string): void {
    const entry = this.fileSearches.get(session); entry?.query?.abort(); entry?.search.dispose(); this.fileSearches.delete(session);
  }
  dispose(): void { for (const key of this.fileSearches.keys()) this.releaseFileCandidates(key); }
  private async fileCandidates(session: string, query: string) {
    const record = await this.options.store.getSession(session);
    if (!record) rpcError("not_found", "session not found");
    const root = record.workspace.directory;
    let entry = this.fileSearches.get(session);
    if (entry?.root !== root) { this.releaseFileCandidates(session); entry = undefined; }
    if (!entry) {
      entry = { root, search: new WorkspaceFileSearch(root, { maxResults: 20, maxEntries: 50000, excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES }) };
      this.fileSearches.set(session, entry);
    }
    this.fileSearches.delete(session); this.fileSearches.set(session, entry);
    while (this.fileSearches.size > 32) this.releaseFileCandidates(this.fileSearches.keys().next().value!);
    entry.query?.abort(); const controller = new AbortController(); entry.query = controller;
    return { items: await entry.search.list(query, controller.signal) };
  }
  private async sessionSkills(session?: string): Promise<SkillManifest[]> {
    if (session !== undefined && !await this.options.store.getSession(session)) rpcError("not_found", "session not found");
    return this.skills();
  }

  private async deleteSession(input: DashboardRpcSpec["sessions.delete"]["input"]): Promise<JsonObject> {
    if (!await this.options.store.getSession(input.session_id)) {
      return rpcError("not_found", "session not found");
    }
    this.options.sessionTitles?.cancel(input.session_id);
    await this.options.terminateSession?.(input.session_id);
    await this.options.approvals?.forgetSession(input.session_id);
    this.options.questions?.forgetSession(input.session_id);
    this.releaseFileCandidates(input.session_id);
    if (!await this.options.store.deleteSession(input.session_id)) {
      return rpcError("not_found", "session not found");
    }
    return { session_id: input.session_id, deleted: true };
  }

  private async session(input: DashboardRpcSpec["sessions.detail"]["input"]): Promise<JsonObject> {
    let detail: JsonObject | undefined;
    try {
      detail = await this.options.store.sessionDetail(input.session_id, {
        limit: integer(input.message_limit, 10, 1, 200),
        ...(input.message_before === undefined ? {} : { before: input.message_before }),
        ...(input.message_after === undefined ? {} : { after: input.message_after }),
        ...(input.message_turn_id === undefined ? {} : { turnId: input.message_turn_id }),
      });
    } catch (error) {
      if (error instanceof InvalidTranscriptCursorError) rpcError("invalid_argument", error.message);
      throw error;
    }
    if (!detail) return rpcError("not_found", "session not found");
    const preview = dashboardSessionDetailPreview(detail, this.options.execSnapshots?.(input.session_id) ?? []);
    // Stamped per window so the desktop can retire optimistic turn content only
    // after the latest transcript window has caught up. Older cursor reads do
    // not replace that latest-window watermark in the Renderer.
    preview.messages_page = { ...object(preview.messages_page), fetched_at: Date.now() };
    return preview;
  }

  private async reloadWorkspace(
    input: DashboardRpcSpec["sessions.workspace.reload"]["input"],
  ): Promise<DashboardRpcResult<"sessions.workspace.reload">> {
    if (!this.options.reloadWorkspace) rpcError("unavailable", "workspace reload is unavailable");
    return this.options.reloadWorkspace(input.session_id) as Promise<DashboardRpcResult<"sessions.workspace.reload">>;
  }

  private skillOptions() {
    return this.options.allowedSkillTypes ? { allowedTypes: this.options.allowedSkillTypes } : {};
  }

  private skills(): SkillManifest[] {
    return this.skillCatalog.list(this.skillOptions());
  }

  private skillReference(name: string, path: string): JsonObject {
    const manifest = this.skills().find((item) => item.name === name);
    if (!manifest) rpcError("not_found", "skill not found");
    const requested = path.replaceAll("\\", "/");
    const reference = manifest.references.find((item) => item.path.replaceAll("\\", "/") === requested);
    if (!reference) rpcError("not_found", "skill reference not found");
    const file = safeChild(manifest.root, reference.path);
    if (!file || !existsSync(file)) rpcError("not_found", "skill reference not found");
    return { skill_name: manifest.name, ...reference, location: file, content: readFileSync(file, "utf8") };
  }

  private skillPayload(manifest: SkillManifest, includeContent = false): JsonObject {
    const diagnostics = this.skillCatalog.diagnostics()
      .filter((diagnostic) => diagnostic.skill_name === manifest.name);
    return {
      name: manifest.name,
      type: manifest.type,
      description: manifest.description,
      commands: manifest.commands,
      location: manifest.location,
      references: manifest.references,
      source: manifest.source,
      ...(diagnostics.length ? { diagnostics } : {}),
      ...(includeContent ? { content: manifest.content } : {}),
    };
  }

  private toolsets(): JsonObject[] {
    const payload = (tool: ReturnType<ToolRegistry["definitionsSnapshot"]>[number]): JsonObject => ({
      name: tool.name,
      raw_name: tool.rawName ?? tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      requires_resource: null,
      source: tool.source,
      exposure: tool.exposure,
      connector_name: tool.connectorName ?? "",
    });
    const native = this.options.tools.definitionsSnapshot().filter((tool) => tool.source !== "mcp");
    const groups: JsonObject[] = native.length ? [{
      name: "coding", label: "Native tools", enabled: true, tools: native.map(payload),
    }] : [];
    for (const server of this.options.mcpConfig.servers) {
      const tools = this.options.tools.definitionsSnapshot()
        .filter((tool) => tool.name.startsWith(mcpServerPrefix(server.name))).map(payload);
      groups.push({ name: `mcp:${server.name}`, label: server.name, enabled: server.enabled, tools, servers: [this.mcpServer(server)] });
    }
    return groups;
  }

  private mcpServer(server: McpConfig["servers"][number]): JsonObject {
    const live = this.options.mcpStatus?.(server.name);
    const toolCount = live?.toolCount
      ?? this.options.tools.definitionsSnapshot().filter((tool) => tool.name.startsWith(mcpServerPrefix(server.name))).length;
    return {
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      status: !server.enabled ? "disabled" : live?.connected ? "ready" : live?.error ? "error" : "configured",
      tool_count: toolCount,
      error: live?.error ?? "",
      server_title: server.connectorName,
      connector_id: server.connectorId,
      connector_name: server.connectorName,
      connector_description: server.connectorDescription,
      exposure: server.exposure,
      tools: live?.tools ?? [],
    };
  }

  private mcpServers(): JsonObject {
    const items = this.options.mcpConfig.servers.map((server) => this.mcpServer(server));
    return { items, total: items.length, tool_total: items.reduce((sum, item) => sum + Number(item.tool_count ?? 0), 0) };
  }

  private async updateMcp(input: DashboardRpcSpec["mcp.servers.update"]["input"]): Promise<JsonObject> {
    const { name, enabled } = input;
    const server = this.options.mcpConfig.servers.find((item) => item.name === name);
    if (!server) rpcError("not_found", "MCP server not found");
    server.enabled = enabled;
    await this.options.setMcpEnabled?.(name, enabled);
    return this.mcpServer(server);
  }

  private days(days: number | undefined): number {
    return integer(days, 30, 1, 365);
  }

  private overview(days: number | undefined): JsonObject {
    return this.options.store.usageOverview(this.days(days));
  }

  private providerSpecs(): Record<string, unknown>[] {
    return loadLlmProviderCatalog(this.options.llmConfigRoot).providers.map((provider) =>
      this.providerSpecPayload(provider));
  }

  private providerSpecPayload(provider: LlmProviderSpec): Record<string, unknown> {
    return {
      name: provider.name,
      label: provider.label,
      aliases: provider.aliases,
      api_style: provider.apiStyle.replaceAll("_", "-"),
      default_model: provider.defaultModel,
      model_aliases: provider.modelAliases,
      models: Object.fromEntries(Object.values(provider.models).map((model) => [model.id, {
        context_window_tokens: model.contextWindowTokens,
        max_tokens: model.maxTokens,
        supports_vision: model.supportsVision,
        supports_thinking: model.supportsThinking,
        supports_temperature: model.supportsTemperature,
        thinking_request_style: model.thinkingRequestStyle,
        thinking_budget_tokens: model.thinkingBudgetTokens,
        thinking_levels: model.thinkingLevels,
        thinking_default: model.thinkingDefault,
      }])),
    };
  }

  private providerSpec(requestedProvider: string): Record<string, unknown> | undefined {
    const requested = normalizeProviderKey(requestedProvider);
    if (!requested) return undefined;
    return this.providerSpecs().find((spec) => {
      const aliases = Array.isArray(spec.aliases) ? spec.aliases : [];
      return [spec.name, ...aliases].some((candidate) => normalizeProviderKey(candidate) === requested);
    });
  }

  private models(): JsonObject[] {
    const items = this.providerSpecs()
      .map((spec) => this.modelPayload(spec))
      .sort((left, right) => text(left.label).localeCompare(text(right.label))
        || text(left.provider).localeCompare(text(right.provider)));
    const state = this.options.managedLlmState?.();
    for (const target of state ? state.models : [this.managedTarget()]) {
      const spec = this.managedProviderSpec(target.provider);
      if (spec && target.model in object(spec.models)) items.push(this.modelPayload(spec, target.model, "cloud"));
      else if (!state) items.push(this.unsupportedManagedModelPayload(target, spec));
    }
    return items;
  }

  private currentModel(): JsonObject {
    const requested = text(this.options.environment.AGENT_LLM_PROVIDER)
      || loadLlmProviderCatalog(this.options.llmConfigRoot).defaultProvider;
    const source = this.options.environment.AGENT_LLM_CREDENTIAL_SOURCE === "cloud" ? "cloud" : "local";
    if (source === "cloud") {
      const target = this.managedTarget();
      const managedSpec = this.managedProviderSpec(target.provider);
      if (managedSpec && target.model in object(managedSpec.models)) {
        return this.modelPayload(managedSpec, target.model, "cloud");
      }
      return this.unsupportedManagedModelPayload(target, managedSpec);
    }
    const spec = this.providerSpec(requested);
    if (spec) {
      return this.modelPayload(spec, undefined, source);
    }
    return this.models()[0] ?? {};
  }

  private selectionPayload(selection: RuntimeModelSelection): JsonObject {
    const spec = selection.credential_source === "cloud"
      ? this.managedProviderSpec(selection.provider) : this.providerSpec(selection.provider);
    const available = spec && selection.model in object(spec.models);
    const payload = available
      ? this.modelPayload(spec, selection.model, selection.credential_source, {
        model: selection.model, thinkingEffort: selection.effort, thinkingEnabled: selection.thinking_enabled ? "1" : "0",
      }) : { ...this.unsupportedManagedModelPayload(selection, spec),
        ...(selection.credential_source === "local" ? { disabled_reason: `Unsupported model: ${selection.provider}/${selection.model}` } : {}) };
    return { ...payload, credential_source: selection.credential_source,
      thinking_state: { ...object(payload.thinking_state), level: selection.effort, enabled: selection.thinking_enabled } };
  }

  private async sessionCurrentModel(sessionId: string): Promise<JsonObject> {
    const session = await this.options.store.getSession(sessionId);
    if (!session) rpcError("not_found", `session not found: ${sessionId}`);
    return { ...(session.model_selection ? this.selectionPayload(session.model_selection) : this.currentModel()),
      session_id: sessionId, selection_version: session.model_selection_version ?? 0 };
  }

  private async selectSessionModel(input: {
    session_id: string; selection_version?: number; provider?: string; model?: string;
    credential_source?: "local" | "cloud"; level?: string;
  }): Promise<JsonObject> {
    const current = await this.sessionCurrentModel(input.session_id);
    if (input.selection_version !== undefined && input.selection_version !== current.selection_version) {
      rpcError("failed_precondition", `session model selection changed: expected version ${input.selection_version}, current ${current.selection_version}`);
    }
    const provider = normalizeProviderKey(input.provider ?? text(current.provider));
    const source = input.credential_source ?? (current.credential_source === "cloud" ? "cloud" : "local");
    const spec = source === "cloud" ? this.managedProviderSpec(provider) : this.providerSpec(provider);
    if (!spec) rpcError("invalid_argument", `Unsupported model provider: ${provider}`);
    const model = input.model || (input.provider ? text(spec.default_model) : text(current.model));
    const modelSpec = object(object(spec.models)[model]);
    if (!(model in object(spec.models))) rpcError("invalid_argument", `Unsupported model: ${provider}/${model}`);
    if (source === "cloud" ? !this.managedConfigured({ provider, model }) : !this.localModelConfigured(provider)) {
      rpcError("failed_precondition", "missing API key");
    }
    const levels = Array.isArray(modelSpec.thinking_levels) ? modelSpec.thinking_levels.map(text) : [];
    const sameModel = current.provider === provider && current.model === model && current.credential_source === source;
    const fallback = text(modelSpec.thinking_default) || levels[0] || "off";
    const requested = input.level?.toLowerCase() ?? (sameModel ? text(object(current.thinking_state).level) : fallback);
    if (input.level !== undefined && !levels.includes(requested)) {
      rpcError("invalid_argument", `Current model thinking level must be one of: ${levels.join(", ")}`);
    }
    const effort = normalizeThinkingEffort(requested, levels, fallback);
    const selection: RuntimeModelSelection = { provider, model, credential_source: source, effort,
      thinking_enabled: levels.length > 0 && effort !== "off" };
    this.options.providerManager?.acquire(selection);
    const version = await this.options.store.setSessionModelSelection(input.session_id, selection,
      input.selection_version ?? Number(current.selection_version));
    const values = { AGENT_LLM_PROVIDER: provider, AGENT_LLM_MODEL: model, AGENT_LLM_CREDENTIAL_SOURCE: source,
      AGENT_LLM_THINKING_ENABLED: selection.thinking_enabled ? "1" : "0", AGENT_LLM_THINKING_EFFORT: effort };
    // Remember the choice for new conversations only; existing ones resolve their own log.
    let generation = 0;
    try {
      const snapshot = await this.options.providerManager?.reconfigure({ provider, model, credentialSource: source,
        thinkingEnabled: selection.thinking_enabled, thinkingEffort: effort });
      generation = snapshot?.generation ?? 0;
      this.updateEnvironment({ ...values, ...providerPreferencePatch(provider, values) });
    } catch (error) {
      createLogger("dashboard.models").warn("default_model_update_failed", { session_id: input.session_id, error: String(error) });
    }
    return { ...this.selectionPayload(selection), session_id: input.session_id, selection_version: version,
      generation, effective_from: "next_turn" };
  }

  private managedTarget(): { provider: string; model: string } {
    const state = this.options.managedLlmState?.();
    if (state) {
      const selected = { provider: text(this.options.environment.LXE_MANAGED_LLM_PROVIDER) || text(this.options.environment.AGENT_LLM_PROVIDER), model: text(this.options.environment.LXE_MANAGED_LLM_MODEL) || text(this.options.environment.AGENT_LLM_MODEL) };
      if (this.options.environment.AGENT_LLM_CREDENTIAL_SOURCE === "cloud" && state.models.some((m) => m.provider === selected.provider && m.model === selected.model)) return selected;
      return state.default_target ?? { provider: "", model: "" };
    }
    const catalog = loadLlmProviderCatalog(this.options.llmConfigRoot);
    const defaultProvider = catalog.requireProvider(catalog.defaultProvider);
    return {
      provider: text(this.options.environment.LXE_MANAGED_LLM_PROVIDER) || defaultProvider.name,
      model: text(this.options.environment.LXE_MANAGED_LLM_MODEL) || defaultProvider.defaultModel,
    };
  }

  private managedProviderSpec(provider: string): Record<string, unknown> | undefined {
    const catalog = withManagedModels(loadLlmProviderCatalog(this.options.llmConfigRoot), this.options.managedLlmState?.());
    const spec = catalog.provider(provider);
    return spec ? this.providerSpecPayload(spec) : undefined;
  }

  private managedConfigured(target: { provider: string; model: string }): boolean {
    const state = this.options.managedLlmState?.();
    if (state) return Boolean(managedCredentialFor(state, target));
    const managedRevision = text(this.options.environment.LXE_MANAGED_LLM_CREDENTIAL_REVISION).toLowerCase();
    return text(this.options.environment.LXE_MANAGED_LLM_PROVIDER) === target.provider
      && text(this.options.environment.LXE_MANAGED_LLM_MODEL) === target.model
      && Boolean(text(this.options.environment.LXE_MANAGED_LLM_API_KEY))
      && /^[a-f0-9]{64}$/u.test(managedRevision)
      && text(this.options.environment.LXE_MANAGED_LLM_INVALID_REVISION).toLowerCase() !== managedRevision;
  }

  private unsupportedManagedModelPayload(
    target: { provider: string; model: string },
    spec?: Record<string, unknown>,
  ): JsonObject {
    const label = text(spec?.label) || target.provider;
    const capabilities = {
      provider: target.provider,
      model: target.model,
      context_window_tokens: 0,
      max_tokens: 0,
      max_output_tokens: 0,
      supports_vision: false,
      supports_thinking: false,
      supports_temperature: false,
    };
    const option = {
      model: target.model,
      thinking_request_style: "none",
      thinking_levels: [],
      thinking_level_labels: {},
      thinking_default: "",
      capabilities,
    };
    return {
      provider: target.provider,
      credential_source: "cloud",
      label,
      api_style: "",
      model: target.model,
      configured: false,
      selectable: false,
      disabled_reason: this.options.managedLlmState?.()?.models.find(m => m.provider === target.provider && m.model === target.model)?.unavailable_reason ?? "unsupported managed model",
      model_options: [option],
      thinking_request_style: "none",
      thinking_levels: [],
      thinking_level_labels: {},
      thinking_default: "",
      thinking_state: { enabled: false, level: "", editable: false },
      capabilities,
    };
  }

  private providerRuntimePreference(provider: string): {
    model: string;
    thinkingEnabled: string;
    thinkingEffort: string;
  } {
    const saved = readProviderPreference(this.options.environment, provider);
    if (normalizeProviderKey(this.options.environment.AGENT_LLM_PROVIDER) !== provider) return saved;
    return {
      model: text(this.options.environment.AGENT_LLM_MODEL) || saved.model,
      thinkingEnabled: text(this.options.environment.AGENT_LLM_THINKING_ENABLED) || saved.thinkingEnabled,
      thinkingEffort: text(this.options.environment.AGENT_LLM_THINKING_EFFORT) || saved.thinkingEffort,
    };
  }

  private modelPayload(
    spec: Record<string, unknown>,
    modelOverride?: string,
    credentialSource: "local" | "cloud" = "local",
    selectedPreference?: { model: string; thinkingEnabled: string; thinkingEffort: string },
  ): JsonObject {
    const name = normalizeProviderKey(spec.name);
    const models = object(spec.models);
    const runtimePreference = selectedPreference ?? this.providerRuntimePreference(name);
    const savedPreference = readProviderPreference(this.options.environment, name);
    const requestedModel = credentialSource === "cloud"
      ? text(modelOverride) || this.managedTarget().model
      : text(modelOverride) || runtimePreference.model || text(spec.default_model);
    const restoredSavedModel = savedPreference.model in models ? savedPreference.model : "";
    const model = requestedModel in models
      ? requestedModel
      : restoredSavedModel || text(spec.default_model);
    const preference = model === restoredSavedModel && requestedModel !== model
      ? savedPreference
      : runtimePreference;
    const selected = object(models[model]);
    const configured = credentialSource === "cloud"
      ? this.managedConfigured({ provider: name, model })
      : this.localModelConfigured(name);
    const levels = Array.isArray(selected.thinking_levels) ? selected.thinking_levels.map(text) : [];
    const defaultEffort = text(selected.thinking_default) || (levels[0] ?? "off");
    const configuredEffort = preference.thinkingEffort.toLowerCase() || defaultEffort;
    const normalizedEffort = normalizeThinkingEffort(configuredEffort, levels, defaultEffort);
    const thinkingRequired = levels.length > 0 && !levels.includes("off");
    const thinkingEnabled = thinkingRequired
      || ((optionalFlag(preference.thinkingEnabled) ?? true) && normalizedEffort !== "off");
    const currentEffort = !thinkingEnabled && levels.includes("off") ? "off" : normalizedEffort;
    const capabilities = {
      provider: name,
      model,
      context_window_tokens: Number(selected.context_window_tokens ?? 0),
      max_tokens: Number(selected.max_tokens ?? 0),
      max_output_tokens: Number(selected.max_tokens ?? 0),
      supports_vision: selected.supports_vision === true,
      supports_thinking: selected.supports_thinking === true,
      supports_temperature: selected.supports_temperature === true,
    };
    const option = (modelName: string): JsonObject => {
      const modelSpec = object(models[modelName]);
      const modelLevels = Array.isArray(modelSpec.thinking_levels) ? modelSpec.thinking_levels.map(text) : [];
      return {
        model: modelName,
        thinking_request_style: text(modelSpec.thinking_request_style),
        thinking_levels: modelLevels,
        thinking_level_labels: object(modelSpec.thinking_level_labels) as JsonObject,
        thinking_default: text(modelSpec.thinking_default),
        capabilities: {
          provider: name, model: modelName,
          context_window_tokens: Number(modelSpec.context_window_tokens ?? 0),
          max_tokens: Number(modelSpec.max_tokens ?? 0), max_output_tokens: Number(modelSpec.max_tokens ?? 0),
          supports_vision: modelSpec.supports_vision === true, supports_thinking: modelSpec.supports_thinking === true,
          supports_temperature: modelSpec.supports_temperature === true,
        },
      };
    };
    return {
      provider: name,
      credential_source: credentialSource,
      label: credentialSource === "cloud" ? this.options.managedLlmState?.()?.models.find(m => m.provider === name && m.model === model)?.definition?.name ?? (text(spec.label) || name) : text(spec.label) || name,
      api_style: text(spec.api_style),
      model,
      configured,
      selectable: configured,
      disabled_reason: configured ? "" : credentialSource === "cloud" ? this.options.managedLlmState?.()?.models.find(m => m.provider === name && m.model === model)?.unavailable_reason ?? "company model credential unavailable" : "missing API key",
      model_options: (credentialSource === "cloud" ? [model] : Object.keys(models)).map(option),
      thinking_request_style: text(selected.thinking_request_style),
      thinking_levels: levels,
      thinking_level_labels: object(selected.thinking_level_labels) as JsonObject,
      thinking_default: text(selected.thinking_default),
      thinking_state: {
        enabled: thinkingEnabled,
        level: currentEffort,
        editable: levels.length > 1,
      },
      capabilities,
    };
  }

  private localModelConfigured(provider: string): boolean {
    try {
      const value: unknown = JSON.parse(
        readFileSync(join(this.options.stateRoot, "config", "auth.json"), "utf8"),
      );
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const credential = (value as Record<string, unknown>)[provider];
      if (credential === null || typeof credential !== "object" || Array.isArray(credential)) return false;
      const record = credential as Record<string, unknown>;
      return record.type === "api_key" && Boolean(text(record.key));
    } catch {
      return false;
    }
  }

  private async updateModel(input: DashboardRpcSpec["models.update"]["input"]): Promise<JsonObject> {
    if (input.session_id) return this.selectSessionModel({ ...input, session_id: input.session_id });
    const spec = input.credential_source === "cloud" ? this.managedProviderSpec(input.provider) : this.providerSpec(input.provider);
    if (!spec) rpcError("invalid_argument", "Unsupported model provider");
    const provider = normalizeProviderKey(spec.name);
    const credentialSource: "local" | "cloud" = input.credential_source === "cloud" ? "cloud" : "local";
    const requestedModel = text(input.model);
    const models = object(spec.models);
    const activeProvider = normalizeProviderKey(this.options.environment.AGENT_LLM_PROVIDER);
    const activePreference = activeProvider ? this.providerRuntimePreference(activeProvider) : undefined;
    const activeModel = activeProvider ? this.currentModel() : undefined;
    const activeThinkingState = object(activeModel?.thinking_state);
    const savedPreference = readProviderPreference(this.options.environment, provider);
    const managedTarget = this.managedTarget();
    const managedState = this.options.managedLlmState?.();
    const preferredModel = credentialSource === "cloud"
      ? managedState ? requestedModel || managedTarget.model : managedTarget.model
      : requestedModel || savedPreference.model || text(spec.default_model);
    if (credentialSource === "cloud" && (managedState
      ? !managedState.models.some((m) => m.provider === provider && m.model === preferredModel)
      : provider !== managedTarget.provider)) rpcError("invalid_argument", "Unsupported managed model provider/model");
    const model = preferredModel in models
      ? preferredModel
      : requestedModel ? preferredModel : text(spec.default_model);
    if (!(model in models)) rpcError("invalid_argument", "Unsupported model for provider");
    const cloudConfigured = this.managedConfigured({ provider, model });
    if (credentialSource === "cloud"
      ? !cloudConfigured
      : !this.localModelConfigured(provider)) {
      rpcError("failed_precondition", "missing API key");
    }
    const modelSpec = object(models[model]);
    const levels = Array.isArray(modelSpec.thinking_levels) ? modelSpec.thinking_levels.map(text) : [];
    const defaultEffort = text(modelSpec.thinking_default) || (levels[0] ?? "off");
    const activeCredentialSource = this.options.environment.AGENT_LLM_CREDENTIAL_SOURCE === "cloud"
      ? "cloud"
      : "local";
    const sameProvider = activeProvider === provider && activeCredentialSource === credentialSource;
    const savedModelMatches = savedPreference.model === model;
    const preferredEffort = sameProvider
      ? text(activeThinkingState.level) || activePreference?.thinkingEffort
      : savedModelMatches ? savedPreference.thinkingEffort : "";
    const preferredEnabled = sameProvider
      ? (activeThinkingState.enabled === false ? "0" : "1")
      : savedModelMatches ? savedPreference.thinkingEnabled : "";
    const normalizedEffort = normalizeThinkingEffort(preferredEffort, levels, defaultEffort);
    const effort = optionalFlag(preferredEnabled) === false && levels.includes("off")
      ? "off"
      : normalizedEffort;
    const patch = {
      provider,
      model,
      credentialSource,
      thinkingEnabled: effort !== "off",
      thinkingEffort: effort,
    };
    const environmentPatch = {
      AGENT_LLM_PROVIDER: provider,
      AGENT_LLM_MODEL: model,
      AGENT_LLM_CREDENTIAL_SOURCE: credentialSource,
      AGENT_LLM_THINKING_ENABLED: effort === "off" ? "0" : "1",
      AGENT_LLM_THINKING_EFFORT: effort,
    };
    const outgoingPreferencePatch = activeProvider && activeModel
      ? providerPreferencePatch(activeProvider, {
        AGENT_LLM_MODEL: text(activeModel.model),
        AGENT_LLM_THINKING_ENABLED: activeThinkingState.enabled === false ? "0" : "1",
        AGENT_LLM_THINKING_EFFORT: text(activeThinkingState.level),
      })
      : {};
    const snapshot = this.options.providerManager
      ? await this.options.providerManager.reconfigure(patch, (values) => {
        const persistedValues = {
          ...outgoingPreferencePatch,
          ...values,
          ...providerPreferencePatch(provider, values),
        };
        Object.assign(this.options.environment, persistedValues);
      })
      : undefined;
    if (!snapshot) this.updateEnvironment({
      ...outgoingPreferencePatch,
      ...environmentPatch,
      ...providerPreferencePatch(provider, environmentPatch),
    });
    return {
      ...this.modelPayload(spec, model, credentialSource),
      generation: snapshot?.generation ?? 0,
      effective_from: "next_turn",
    };
  }

  private async updateThinking(input: DashboardRpcSpec["models.thinking.update"]["input"]): Promise<JsonObject> {
    if (input.session_id) return this.selectSessionModel({ ...input, session_id: input.session_id });
    const current = this.currentModel();
    const level = text(input.level).toLowerCase();
    const levels = Array.isArray(current.thinking_levels) ? current.thinking_levels.map(text) : [];
    if (!levels.includes(level)) {
      rpcError("invalid_argument", `Current model thinking level must be one of: ${levels.join(", ")}`);
    }
    const provider = normalizeProviderKey(current.provider);
    const environmentPatch = { AGENT_LLM_THINKING_ENABLED: level === "off" ? "0" : "1", AGENT_LLM_THINKING_EFFORT: level };
    const snapshot = this.options.providerManager
      ? await this.options.providerManager.reconfigure({ thinkingEnabled: level !== "off", thinkingEffort: level }, (values) => {
        const persistedValues = { ...values, ...providerPreferencePatch(provider, values) };
        Object.assign(this.options.environment, persistedValues);
      })
      : undefined;
    if (!snapshot) this.updateEnvironment({
      ...environmentPatch,
      ...providerPreferencePatch(provider, environmentPatch),
    });
    return { ...this.currentModel(), generation: snapshot?.generation ?? 0, effective_from: "next_turn" };
  }

  private updateEnvironment(values: Record<string, string>): void {
    Object.assign(this.options.environment, values);
  }
}
