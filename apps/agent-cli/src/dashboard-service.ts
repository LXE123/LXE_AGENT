import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  DashboardRpcError,
  type AgentDashboardRpcCall,
  type AgentDashboardRpcHandlers,
  type AgentDashboardRpcOperation,
  type DashboardRpcResult,
  type DashboardRpcSpec,
} from "@lxe/desktop-protocol";
import type { JsonObject } from "@lxe/protocol";
import {
  mcpServerPrefix,
  normalizeThinkingEffort,
  providerPreferencePatch,
  readProviderPreference,
  runtimeConfigPaths,
  SkillCatalog,
  type McpConfig,
  type LxeSkillCommandDefinition,
  type RuntimeProviderManager,
  type SkillManifest,
  type SqliteRuntimeStore,
  type ToolRegistry,
} from "@lxe/runtime";

type Environment = Record<string, string | undefined>;

/** Agent-process dependencies required by the Dashboard query service. */
interface DashboardServiceOptions {
  /** Read-only application resources containing config schemas, skills, and docs. */
  projectRoot: string;
  /** Writable desktop/source state. Defaults to projectRoot for source compatibility. */
  stateRoot?: string;
  environment: Environment;
  store: SqliteRuntimeStore;
  tools: ToolRegistry;
  mcpConfig: McpConfig;
  connectorStatePath?: string;
  backgroundTasks?: () => JsonObject[];
  setMcpEnabled?: (serverName: string, enabled: boolean) => Promise<void> | void;
  mcpStatus?: (serverName: string) => {
    connected: boolean;
    error: string;
    toolCount?: number;
    tools?: Array<{ rawName: string; modelName: string }>;
  };
  providerManager?: RuntimeProviderManager;
  skillCatalog?: SkillCatalog;
  allowedSkillTypes?: ReadonlySet<string>;
  cliCommands?: LxeSkillCommandDefinition[];
  reloadWorkspace?: (sessionId: string) => Promise<JsonObject>;
}

const connectorDefinitions = [
  {
    id: "feishu",
    name: "Feishu / Lark CLI",
    description: "Controls the official lark-cli skill pack.",
    kind: "cli",
    skill_names: [
      "lark-approval", "lark-apps", "lark-attendance", "lark-base", "lark-calendar", "lark-contact",
      "lark-doc", "lark-drive", "lark-event", "lark-im", "lark-mail", "lark-markdown", "lark-minutes",
      "lark-note", "lark-okr", "lark-openapi-explorer", "lark-shared", "lark-sheets", "lark-skill-maker",
      "lark-slides", "lark-task", "lark-vc", "lark-vc-agent", "lark-whiteboard", "lark-wiki",
      "lark-workflow-meeting-summary", "lark-workflow-standup-report",
    ],
  },
  {
    id: "dingtalk",
    name: "DingTalk Workspace CLI",
    description: "Controls the official dws skill.",
    kind: "cli",
    skill_names: ["dws"],
  },
] as const;

const text = (value: unknown): string => String(value ?? "").trim();
const normalizeProviderKey = (value: unknown): string =>
  text(value).toLowerCase().replaceAll("-", "_").replaceAll(/\s+/g, "_");
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

const recursiveFiles = (root: string, predicate: (path: string) => boolean): string[] => {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && predicate(path)) output.push(path);
    }
  };
  walk(root);
  return output.sort((left, right) => left.localeCompare(right));
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

const markdownTitle = (content: string, fallback: string): string => {
  const heading = content.split(/\r?\n/).find((line) => line.trim().startsWith("# "));
  return heading?.trim().slice(2).trim() || fallback;
};

const markdownStatus = (content: string): string => {
  for (const line of content.split(/\r?\n/).slice(0, 20)) {
    const match = line.trim().match(/^(?:status|状态)\s*[:：]\s*(.+)$/i);
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
};

const loadJson = (path: string): Record<string, unknown> => object(JSON.parse(readFileSync(path, "utf8")));

function rpcError(code: ConstructorParameters<typeof DashboardRpcError>[0], message: string): never {
  throw new DashboardRpcError(code, message);
}

export class DashboardService {
  private readonly connectorStatePath: string;
  private readonly skillCatalog: SkillCatalog;
  private connectorStateCache: {
    fingerprint: string;
    state: { enabled: string[]; everConnected: string[]; userDisabled: string[] };
  } | undefined;

  private readonly handlers: AgentDashboardRpcHandlers = {
    "sessions.list": (input) => this.sessions(input) as DashboardRpcResult<"sessions.list">,
    "sessions.detail": (input) => this.session(input) as Promise<DashboardRpcResult<"sessions.detail">>,
    "sessions.workspace.reload": (input) => this.reloadWorkspace(input),
    "skills.list": () => this.listPayload(this.skills()) as DashboardRpcResult<"skills.list">,
    "skills.content": (input) => this.skillContent(input.name) as DashboardRpcResult<"skills.content">,
    "skills.reference": (input) => this.skillReference(input.name, input.path) as DashboardRpcResult<"skills.reference">,
    "commands.list": () => this.listPayload(this.options.cliCommands ?? []) as DashboardRpcResult<"commands.list">,
    "docs.list": () => this.listPayload(this.docs()) as DashboardRpcResult<"docs.list">,
    "docs.content": (input) => this.doc(input.path) as DashboardRpcResult<"docs.content">,
    "connectors.list": () => this.listPayload(this.connectors()) as DashboardRpcResult<"connectors.list">,
    "connectors.update": (input) => this.updateConnector(input) as Promise<DashboardRpcResult<"connectors.update">>,
    "toolsets.list": () => this.listPayload(this.toolsets()) as DashboardRpcResult<"toolsets.list">,
    "mcp.servers.list": () => this.mcpServers() as DashboardRpcResult<"mcp.servers.list">,
    "mcp.servers.update": (input) => this.updateMcp(input) as Promise<DashboardRpcResult<"mcp.servers.update">>,
    "backgroundTasks.list": () => this.listPayload(this.options.backgroundTasks?.() ?? []) as DashboardRpcResult<"backgroundTasks.list">,
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
    "models.current": () => this.currentModel() as DashboardRpcResult<"models.current">,
    "models.update": (input) => this.updateModel(input) as Promise<DashboardRpcResult<"models.update">>,
    "models.thinking.update": (input) => this.updateThinking(input) as Promise<DashboardRpcResult<"models.thinking.update">>,
  };

  constructor(private readonly options: DashboardServiceOptions) {
    this.connectorStatePath = options.connectorStatePath
      ?? (text(options.environment.LXE_CONNECTOR_STATE_PATH)
        || join(options.stateRoot ?? options.projectRoot, "config", "connector-states.local.json"));
    this.skillCatalog = options.skillCatalog ?? new SkillCatalog(options.projectRoot);
  }

  async call<O extends AgentDashboardRpcOperation>(
    call: AgentDashboardRpcCall<O>,
  ): Promise<DashboardRpcResult<O>> {
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
    });
  }

  private async session(input: DashboardRpcSpec["sessions.detail"]["input"]): Promise<JsonObject> {
    const detail = await this.options.store.sessionDetail(input.session_id, {
      limit: integer(input.message_limit, 10, 1, 200),
      ...(input.message_page === undefined
        ? {}
        : { page: integer(input.message_page, 1, 1, Number.MAX_SAFE_INTEGER) }),
    });
    return detail ?? rpcError("not_found", "session not found");
  }

  private async reloadWorkspace(
    input: DashboardRpcSpec["sessions.workspace.reload"]["input"],
  ): Promise<DashboardRpcResult<"sessions.workspace.reload">> {
    if (!this.options.reloadWorkspace) rpcError("unavailable", "workspace reload is unavailable");
    return this.options.reloadWorkspace(input.session_id) as Promise<DashboardRpcResult<"sessions.workspace.reload">>;
  }

  private skills(): SkillManifest[] {
    return this.skillCatalog.list({
      disabledNames: this.disabledSkillNames(),
      ...(this.options.allowedSkillTypes ? { allowedTypes: this.options.allowedSkillTypes } : {}),
    });
  }

  disabledSkillNames(): Set<string> {
    return this.runtimeConnectorPolicy().disabledSkillNames;
  }

  disabledConnectorIds(): Set<string> {
    return this.runtimeConnectorPolicy().disabledConnectorIds;
  }

  runtimeConnectorPolicy(): { disabledSkillNames: Set<string>; disabledConnectorIds: Set<string> } {
    const disabled = this.connectors().filter((item) => !item.enabled);
    return {
      disabledSkillNames: new Set(disabled.flatMap((item) => item.skill_names)),
      disabledConnectorIds: new Set(disabled.map((item) => String(item.id))),
    };
  }

  invalidateRuntimeConfigCache(): void {
    this.connectorStateCache = undefined;
  }

  private skillContent(name: string): JsonObject {
    const manifest = this.skills().find((item) => item.name === name);
    if (!manifest) rpcError("not_found", "skill not found");
    return this.skillPayload(manifest, true);
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
    return {
      name: manifest.name,
      type: manifest.type,
      description: manifest.description,
      commands: manifest.commands,
      location: manifest.location,
      references: manifest.references,
      ...(includeContent ? { content: manifest.content } : {}),
    };
  }

  private docs(): JsonObject[] {
    const root = join(this.options.projectRoot, "docs");
    return recursiveFiles(root, (path) => extname(path).toLowerCase() === ".md").map((path) => {
      const content = readFileSync(path, "utf8");
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const parent = dirname(relativePath).replaceAll("\\", "/");
      return {
        path: relativePath,
        title: markdownTitle(content, basename(relativePath, ".md").replaceAll(/[-_]/g, " ")),
        section: parent === "." ? "" : parent,
        status: markdownStatus(content),
        size: statSync(path).size,
      };
    });
  }

  private doc(path: string): JsonObject {
    const file = safeChild(join(this.options.projectRoot, "docs"), path, ".md");
    if (!file || !existsSync(file)) rpcError("not_found", "project doc not found");
    const relativePath = relative(join(this.options.projectRoot, "docs"), file).replaceAll("\\", "/");
    const item = this.docs().find((doc) => doc.path === relativePath);
    return item
      ? { ...item, content: readFileSync(file, "utf8") }
      : rpcError("not_found", "project doc not found");
  }

  private connectorState(): { enabled: string[]; everConnected: string[]; userDisabled: string[] } {
    let fingerprint = "missing";
    try {
      const info = statSync(this.connectorStatePath);
      fingerprint = `${info.size}:${info.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.connectorStateCache?.fingerprint === fingerprint) {
      return structuredClone(this.connectorStateCache.state);
    }
    try {
      const state = object(JSON.parse(readFileSync(this.connectorStatePath, "utf8")));
      const known = new Set(connectorDefinitions.map((item) => item.id));
      const ids = (value: unknown): string[] => Array.isArray(value)
        ? value.map(text).filter((item) => known.has(item as typeof connectorDefinitions[number]["id"]))
        : [];
      const parsed = { enabled: ids(state.enabled), everConnected: ids(state.everConnected), userDisabled: ids(state.userDisabled) };
      this.connectorStateCache = { fingerprint, state: parsed };
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const empty = { enabled: [], everConnected: [], userDisabled: [] };
      this.connectorStateCache = { fingerprint, state: empty };
      return structuredClone(empty);
    }
  }

  private connectors(): Array<JsonObject & { enabled: boolean; skill_names: string[] }> {
    const state = this.connectorState();
    return connectorDefinitions.map((definition) => ({
      ...definition,
      skill_names: [...definition.skill_names],
      skill_count: definition.skill_names.length,
      enabled: state.enabled.includes(definition.id),
      everConnected: state.everConnected.includes(definition.id),
      userDisabled: state.userDisabled.includes(definition.id),
    }));
  }

  private async updateConnector(input: DashboardRpcSpec["connectors.update"]["input"]): Promise<JsonObject> {
    const { id, enabled } = input;
    if (!connectorDefinitions.some((item) => item.id === id)) rpcError("not_found", "connector not found");
    const state = this.connectorState();
    const update = (items: string[], include: boolean): string[] => [...new Set(include
      ? [...items, id]
      : items.filter((item) => item !== id))].sort();
    const next = {
      version: 1,
      enabled: update(state.enabled, enabled),
      everConnected: update(state.everConnected, enabled || state.everConnected.includes(id)),
      userDisabled: update(state.userDisabled, !enabled),
    };
    mkdirSync(dirname(this.connectorStatePath), { recursive: true });
    const temporary = `${this.connectorStatePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, this.connectorStatePath);
    this.connectorStateCache = undefined;
    return this.connectors().find((item) => item.id === id)!;
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
    const providerRoot = runtimeConfigPaths(this.options.projectRoot).providers;
    if (!existsSync(providerRoot)) return [];
    return readdirSync(providerRoot)
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => loadJson(join(providerRoot, name)));
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
    return this.providerSpecs()
      .map((spec) => this.modelPayload(spec))
      .sort((left, right) => text(left.provider).localeCompare(text(right.provider)));
  }

  private currentModel(): JsonObject {
    const requested = text(this.options.environment.AGENT_LLM_PROVIDER) || "kimi_coding";
    const spec = this.providerSpec(requested);
    if (spec) {
      return this.modelPayload(spec);
    }
    return this.models()[0] ?? {};
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

  private modelPayload(spec: Record<string, unknown>, modelOverride?: string): JsonObject {
    const name = normalizeProviderKey(spec.name);
    const models = object(spec.models);
    const runtimePreference = this.providerRuntimePreference(name);
    const savedPreference = readProviderPreference(this.options.environment, name);
    const requestedModel = text(modelOverride) || runtimePreference.model || text(spec.default_model);
    const restoredSavedModel = savedPreference.model in models ? savedPreference.model : "";
    const model = requestedModel in models
      ? requestedModel
      : restoredSavedModel || text(spec.default_model);
    const preference = model === restoredSavedModel && requestedModel !== model
      ? savedPreference
      : runtimePreference;
    const selected = object(models[model]);
    const envNames = this.authEnvNames(name);
    const configured = envNames.some((envName) => Boolean(text(this.options.environment[envName])));
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
      label: text(spec.label) || name,
      api_style: text(spec.api_style),
      model,
      configured,
      selectable: configured && ["kimi_coding", "deepseek"].includes(name),
      disabled_reason: configured ? (["kimi_coding", "deepseek"].includes(name) ? "" : "not selectable in WebUI") : "missing API key",
      model_options: Object.keys(models).map(option),
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

  private authEnvNames(provider: string): string[] {
    try {
      const profiles = object(loadJson(runtimeConfigPaths(this.options.projectRoot).authProfiles).profiles);
      const names = object(profiles[provider]).env_names;
      return Array.isArray(names) ? names.map(text) : [];
    } catch {
      return [];
    }
  }

  private async updateModel(input: DashboardRpcSpec["models.update"]["input"]): Promise<JsonObject> {
    const spec = this.providerSpec(input.provider);
    if (!spec) rpcError("invalid_argument", "Unsupported model provider");
    const provider = normalizeProviderKey(spec.name);
    const requestedModel = text(input.model);
    const models = object(spec.models);
    const activeProvider = normalizeProviderKey(this.options.environment.AGENT_LLM_PROVIDER);
    const activePreference = activeProvider ? this.providerRuntimePreference(activeProvider) : undefined;
    const activeModel = activeProvider ? this.currentModel() : undefined;
    const activeThinkingState = object(activeModel?.thinking_state);
    const savedPreference = readProviderPreference(this.options.environment, provider);
    const preferredModel = requestedModel || savedPreference.model || text(spec.default_model);
    const model = preferredModel in models
      ? preferredModel
      : requestedModel ? preferredModel : text(spec.default_model);
    if (!(model in models)) rpcError("invalid_argument", "Unsupported model for provider");
    if (!this.authEnvNames(provider).some((name) => Boolean(text(this.options.environment[name])))) {
      rpcError("failed_precondition", "missing API key");
    }
    const modelSpec = object(models[model]);
    const levels = Array.isArray(modelSpec.thinking_levels) ? modelSpec.thinking_levels.map(text) : [];
    const defaultEffort = text(modelSpec.thinking_default) || (levels[0] ?? "off");
    const sameProvider = activeProvider === provider;
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
      thinkingEnabled: effort !== "off",
      thinkingEffort: effort,
    };
    const environmentPatch = {
      AGENT_LLM_PROVIDER: provider,
      AGENT_LLM_MODEL: model,
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
        this.persistEnvironment(persistedValues);
        Object.assign(this.options.environment, persistedValues);
      })
      : undefined;
    if (!snapshot) this.updateEnvironment({
      ...outgoingPreferencePatch,
      ...environmentPatch,
      ...providerPreferencePatch(provider, environmentPatch),
    });
    return {
      ...this.modelPayload(spec, model),
      generation: snapshot?.generation ?? 0,
      effective_from: "next_turn",
    };
  }

  private async updateThinking(input: DashboardRpcSpec["models.thinking.update"]["input"]): Promise<JsonObject> {
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
        this.persistEnvironment(persistedValues);
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
    this.persistEnvironment(values);
    Object.assign(this.options.environment, values);
  }

  private persistEnvironment(values: Record<string, string>): void {
    const path = join(this.options.stateRoot ?? this.options.projectRoot, ".env.local");
    let lines: string[] = [];
    try { lines = readFileSync(path, "utf8").split(/\r?\n/); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const [key, value] of Object.entries(values)) {
      const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
      if (index >= 0) lines[index] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${lines.filter((line, index) => line || index < lines.length - 1).join("\n")}\n`, "utf8");
    renameSync(temporary, path);
  }
}
