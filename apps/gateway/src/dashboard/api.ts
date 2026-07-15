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
import type { JsonObject } from "@lxe/protocol";
import {
  mcpServerPrefix,
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

interface DashboardApiOptions {
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

const json = (value: unknown, status = 200): Response => Response.json(value, { status });
const text = (value: unknown): string => String(value ?? "").trim();
const integer = (value: string | null, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
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
  let requested: string;
  try {
    requested = decodeURIComponent(rawPath).replaceAll("\\", "/");
  } catch {
    return undefined;
  }
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

export class DashboardApi {
  private readonly connectorStatePath: string;
  private readonly skillCatalog: SkillCatalog;

  constructor(private readonly options: DashboardApiOptions) {
    this.connectorStatePath = options.connectorStatePath
      ?? (text(options.environment.LXE_CONNECTOR_STATE_PATH)
        || join(options.stateRoot ?? options.projectRoot, "config", "connector-states.local.json"));
    this.skillCatalog = options.skillCatalog ?? new SkillCatalog(options.projectRoot);
  }

  async handle(request: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/sessions") return json(this.sessions(url));
    if (request.method === "GET" && path.startsWith("/api/sessions/")) return this.session(path, url);
    if (request.method === "GET" && path === "/api/skills") return json(this.listPayload(this.skills()));
    if (request.method === "GET" && path === "/api/commands") return json(this.listPayload(this.options.cliCommands ?? []));
    if (request.method === "GET" && path.startsWith("/api/skills/")) return this.skill(path);
    if (request.method === "GET" && path === "/api/project-docs") return json(this.listPayload(this.docs()));
    if (request.method === "GET" && path.startsWith("/api/project-docs/")) return this.doc(path);
    if (request.method === "GET" && path === "/api/connectors") return json(this.listPayload(this.connectors()));
    if (request.method === "PATCH" && path.startsWith("/api/connectors/")) return this.patchConnector(request, path);
    if (request.method === "GET" && path === "/api/tools/toolsets") return json(this.listPayload(this.toolsets()));
    if (request.method === "GET" && path === "/api/mcp/servers") return json(this.mcpServers());
    if (request.method === "PATCH" && path.startsWith("/api/mcp/servers/")) return this.patchMcp(request, path);
    if (request.method === "GET" && path === "/api/background-tasks") {
      return json(this.listPayload(this.options.backgroundTasks?.() ?? []));
    }
    if (request.method === "GET" && path === "/api/stats/overview") return json(this.overview(url));
    if (request.method === "GET" && path === "/api/stats/skills") {
      const days = this.days(url);
      return json({ ...this.listPayload(this.options.store.skillUsageStats(days)), days });
    }
    if (request.method === "GET" && path.startsWith("/api/stats/skills/")) {
      const name = decodeURIComponent(path.slice("/api/stats/skills/".length));
      const days = this.days(url);
      return json({ ...this.options.store.skillUsageDetail(name, days), days });
    }
    if (request.method === "GET" && path === "/api/stats/tools") {
      const days = this.days(url);
      return json({ ...this.listPayload(this.options.store.toolUsageStats(days)), days });
    }
    if (request.method === "GET" && path === "/api/models") return json(this.listPayload(this.models()));
    if (request.method === "GET" && path === "/api/models/current") return json(this.currentModel());
    if (request.method === "PATCH" && path === "/api/models/current") return this.patchModel(request);
    if (request.method === "PATCH" && path === "/api/models/current/thinking") return this.patchThinking(request);
    return undefined;
  }

  private listPayload(items: unknown[]): { items: unknown[]; total: number } {
    return { items, total: items.length };
  }

  private sessions(url: URL): ReturnType<SqliteRuntimeStore["listSessions"]> {
    return this.options.store.listSessions({
      limit: integer(url.searchParams.get("limit"), 50, 1, 200),
      offset: integer(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
      query: url.searchParams.get("q") ?? "",
    });
  }

  private async session(path: string, url: URL): Promise<Response> {
    const sessionId = decodeURIComponent(path.slice("/api/sessions/".length));
    const detail = await this.options.store.sessionDetail(sessionId, {
      limit: integer(url.searchParams.get("message_limit"), 10, 1, 200),
      ...(url.searchParams.has("message_page")
        ? { page: integer(url.searchParams.get("message_page"), 1, 1, Number.MAX_SAFE_INTEGER) }
        : {}),
    });
    return detail ? json(detail) : json({ detail: "session not found" }, 404);
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

  private skill(path: string): Response {
    const rest = path.slice("/api/skills/".length);
    const contentSuffix = "/content";
    const referenceMarker = "/references/";
    const name = decodeURIComponent(rest.includes(referenceMarker)
      ? rest.slice(0, rest.indexOf(referenceMarker))
      : rest.endsWith(contentSuffix) ? rest.slice(0, -contentSuffix.length) : rest);
    const manifest = this.skills().find((item) => item.name === name);
    if (!manifest) return json({ detail: "skill not found" }, 404);
    if (rest.endsWith(contentSuffix)) return json(this.skillPayload(manifest, true));
    const markerIndex = rest.indexOf(referenceMarker);
    if (markerIndex < 0) return json({ detail: "not found" }, 404);
    const requested = decodeURIComponent(rest.slice(markerIndex + referenceMarker.length)).replaceAll("\\", "/");
    const reference = manifest.references.find((item) => item.path.replaceAll("\\", "/") === requested);
    if (!reference) return json({ detail: "skill reference not found" }, 404);
    const file = safeChild(manifest.root, reference.path);
    if (!file || !existsSync(file)) return json({ detail: "skill reference not found" }, 404);
    return json({ skill_name: manifest.name, ...reference, location: file, content: readFileSync(file, "utf8") });
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

  private doc(path: string): Response {
    const requestPath = path.slice("/api/project-docs/".length);
    const file = safeChild(join(this.options.projectRoot, "docs"), requestPath, ".md");
    if (!file || !existsSync(file)) return json({ detail: "project doc not found" }, 404);
    const relativePath = relative(join(this.options.projectRoot, "docs"), file).replaceAll("\\", "/");
    const item = this.docs().find((doc) => doc.path === relativePath);
    return item ? json({ ...item, content: readFileSync(file, "utf8") }) : json({ detail: "project doc not found" }, 404);
  }

  private connectorState(): { enabled: string[]; everConnected: string[]; userDisabled: string[] } {
    try {
      const state = object(JSON.parse(readFileSync(this.connectorStatePath, "utf8")));
      const known = new Set(connectorDefinitions.map((item) => item.id));
      const ids = (value: unknown): string[] => Array.isArray(value)
        ? value.map(text).filter((item) => known.has(item as typeof connectorDefinitions[number]["id"]))
        : [];
      return { enabled: ids(state.enabled), everConnected: ids(state.everConnected), userDisabled: ids(state.userDisabled) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { enabled: [], everConnected: [], userDisabled: [] };
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

  private async patchConnector(request: Request, path: string): Promise<Response> {
    const id = decodeURIComponent(path.slice("/api/connectors/".length));
    if (!connectorDefinitions.some((item) => item.id === id)) return json({ detail: "connector not found" }, 404);
    const body = object(await request.json());
    if (typeof body.enabled !== "boolean") return json({ detail: "enabled must be a boolean" }, 400);
    const state = this.connectorState();
    const update = (items: string[], include: boolean): string[] => [...new Set(include
      ? [...items, id]
      : items.filter((item) => item !== id))].sort();
    const next = {
      version: 1,
      enabled: update(state.enabled, body.enabled),
      everConnected: update(state.everConnected, body.enabled || state.everConnected.includes(id)),
      userDisabled: update(state.userDisabled, !body.enabled),
    };
    mkdirSync(dirname(this.connectorStatePath), { recursive: true });
    const temporary = `${this.connectorStatePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, this.connectorStatePath);
    return json(this.connectors().find((item) => item.id === id));
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

  private async patchMcp(request: Request, path: string): Promise<Response> {
    const name = decodeURIComponent(path.slice("/api/mcp/servers/".length));
    const server = this.options.mcpConfig.servers.find((item) => item.name === name);
    if (!server) return json({ detail: "MCP server not found" }, 404);
    const body = object(await request.json());
    if (typeof body.enabled !== "boolean") return json({ detail: "enabled must be a boolean" }, 400);
    server.enabled = body.enabled;
    await this.options.setMcpEnabled?.(name, body.enabled);
    return json(this.mcpServer(server));
  }

  private days(url: URL): number {
    return integer(url.searchParams.get("days"), 30, 1, 365);
  }

  private overview(url: URL): JsonObject {
    return this.options.store.usageOverview(this.days(url));
  }

  private models(): JsonObject[] {
    const providerRoot = runtimeConfigPaths(this.options.projectRoot).providers;
    if (!existsSync(providerRoot)) return [];
    return readdirSync(providerRoot).filter((name) => name.endsWith(".json"))
      .map((name) => this.modelPayload(loadJson(join(providerRoot, name))))
      .sort((left, right) => text(left.provider).localeCompare(text(right.provider)));
  }

  private currentModel(): JsonObject {
    const models = this.models();
    const requested = text(this.options.environment.AGENT_LLM_PROVIDER) || "kimi_coding";
    return models.find((model) => model.provider === requested) ?? models[0] ?? {};
  }

  private modelPayload(spec: Record<string, unknown>, modelOverride?: string): JsonObject {
    const name = text(spec.name);
    const models = object(spec.models);
    const model = modelOverride || text(spec.default_model);
    const selected = object(models[model]);
    const envNames = this.authEnvNames(name);
    const configured = envNames.some((envName) => Boolean(text(this.options.environment[envName])));
    const levels = Array.isArray(selected.thinking_levels) ? selected.thinking_levels.map(text) : [];
    const currentEffort = text(this.options.environment.AGENT_LLM_THINKING_EFFORT) || text(selected.thinking_default) || "off";
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
      thinking_state: { enabled: this.options.environment.AGENT_LLM_THINKING_ENABLED !== "0" && currentEffort !== "off", level: currentEffort, editable: levels.includes("off") },
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

  private async patchModel(request: Request): Promise<Response> {
    const body = object(await request.json());
    const provider = text(body.provider);
    const requestedModel = text(body.model);
    const specPath = join(runtimeConfigPaths(this.options.projectRoot).providers, `${provider}.json`);
    if (!existsSync(specPath)) return json({ detail: "Unsupported model provider" }, 400);
    const spec = loadJson(specPath);
    const models = object(spec.models);
    const model = requestedModel || text(spec.default_model);
    if (!(model in models)) return json({ detail: "Unsupported model for provider" }, 400);
    if (!this.authEnvNames(provider).some((name) => Boolean(text(this.options.environment[name])))) return json({ detail: "missing API key" }, 400);
    const modelSpec = object(models[model]);
    const levels = Array.isArray(modelSpec.thinking_levels) ? modelSpec.thinking_levels.map(text) : [];
    const currentEffort = text(this.options.environment.AGENT_LLM_THINKING_EFFORT).toLowerCase();
    const effort = levels.includes(currentEffort) ? currentEffort : text(modelSpec.thinking_default) || (levels[0] ?? "off");
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
    const snapshot = this.options.providerManager
      ? await this.options.providerManager.reconfigure(patch, (values) => this.persistEnvironment(values))
      : undefined;
    if (!snapshot) this.updateEnvironment(environmentPatch);
    return json({
      ...this.modelPayload(spec, model),
      generation: snapshot?.generation ?? 0,
      effective_from: "next_turn",
    });
  }

  private async patchThinking(request: Request): Promise<Response> {
    const body = object(await request.json());
    const current = this.currentModel();
    const level = text(body.level).toLowerCase();
    const levels = Array.isArray(current.thinking_levels) ? current.thinking_levels.map(text) : [];
    if (!levels.includes(level)) return json({ detail: `Current model thinking level must be one of: ${levels.join(", ")}` }, 400);
    const environmentPatch = { AGENT_LLM_THINKING_ENABLED: level === "off" ? "0" : "1", AGENT_LLM_THINKING_EFFORT: level };
    const snapshot = this.options.providerManager
      ? await this.options.providerManager.reconfigure({ thinkingEnabled: level !== "off", thinkingEffort: level }, (values) => this.persistEnvironment(values))
      : undefined;
    if (!snapshot) this.updateEnvironment(environmentPatch);
    return json({ ...this.currentModel(), generation: snapshot?.generation ?? 0, effective_from: "next_turn" });
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
