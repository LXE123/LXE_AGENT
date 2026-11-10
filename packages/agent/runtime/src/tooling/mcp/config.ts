import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Environment } from "@lxe/core";
import type { McpConfig, McpServerConfig, McpTransportKind } from "./types";
import { mapping, stringMapping } from "./support";
import { reserveMcpNamespace } from "./naming";

const resolvePlaceholders = (value: string, env: Environment, field: string): string =>
  value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") throw new Error(`missing environment variable ${name} for MCP ${field}`);
    return resolved;
  });

const seconds = (value: unknown, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed * 1_000) : fallback * 1_000;
};

const stringSet = (value: unknown): Set<string> => new Set(Array.isArray(value)
  ? value.map((item) => String(item).trim()).filter(Boolean)
  : []);

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP ${field} must be an object`);
  return value as Record<string, unknown>;
};

/** JSON only. Never discovers, merges or rewrites legacy YAML files. */
export function readMcpConfigDocument(path: string): Record<string, unknown> {
  const root = object(JSON.parse(readFileSync(path, "utf8")), "configuration");
  if (root.servers !== undefined && root.mcpServers !== undefined) throw new Error("MCP configuration must use only one server map: servers or mcpServers");
  const servers = object(root.servers !== undefined ? root.servers : root.mcpServers !== undefined ? root.mcpServers : {}, "servers");
  for (const [name, server] of Object.entries(servers)) object(server, `server ${name}`);
  return root;
}

export function writeMcpConfigDocument(path: string, root: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(root, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function parseExposure(value: unknown, name: string): McpServerConfig["exposure"] {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (mode == null || mode === "auto") return "codemode";
  if (mode === "codemode" || mode === "deferred" || mode === "direct" || mode === "hidden") return mode;
  throw new Error(`invalid MCP exposure for ${name}: ${mode}`);
}

function readOrEmpty(path: string): Record<string, unknown> {
  try {
    return readMcpConfigDocument(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function loadMcpConfig(path: string, env: Environment, defaultCwd = ""): McpConfig {
  return parseMcpConfig(readOrEmpty(path), env, defaultCwd);
}

function parseMcpConfig(root: Record<string, unknown>, env: Environment, defaultCwd: string): McpConfig {
  const servers = mapping(root.mcpServers ?? root.servers);
  const namespaces = new Map<string, string>();
  return {
    servers: Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)).map(([name, raw]) => {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
      reserveMcpNamespace(namespaces, name);
      const config = mapping(raw);
      if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error(`MCP ${name}.enabled must be a boolean`);
      for (const field of ["args", "enabled_tools", "disabled_tools", "enabledTools", "disabledTools"]) {
        if (config[field] !== undefined && (!Array.isArray(config[field]) || !(config[field] as unknown[]).every(item => typeof item === "string"))) {
          throw new Error(`MCP ${name}.${field} must be an array of strings`);
        }
      }
      for (const field of ["env", "headers", "env_headers", "envHeaders"]) {
        if (config[field] !== undefined && !Object.values(object(config[field], `${name}.${field}`)).every(item => typeof item === "string")) {
          throw new Error(`MCP ${name}.${field} values must be strings`);
        }
      }
      const rawTransport = String(config.transport ?? config.type ?? "stdio").toLowerCase().replaceAll("_", "-");
      const transport: McpTransportKind = ["http", "streamable-http"].includes(rawTransport)
        ? "streamable-http"
        : rawTransport === "stdio" ? "stdio" : (() => { throw new Error(`unsupported MCP transport: ${rawTransport}`); })();
      const required = transport === "stdio" ? "command" : "url";
      if (typeof config[required] !== "string" || !config[required].trim()) throw new Error(`MCP ${name}.${required} is required`);
      const headers = stringMapping(config.headers);
      const protocolMode = String(config.protocol_mode ?? config.protocolMode ?? "auto");
      if (protocolMode !== "auto" && protocolMode !== "legacy" && protocolMode !== "2026-07-28") {
        throw new Error(`unsupported MCP protocol_mode for ${name}: ${protocolMode}`);
      }
      return {
        name,
        enabled: config.enabled === true,
        transport,
        protocolMode,
        command: resolvePlaceholders(String(config.command ?? "").trim(), env, `${name}.command`),
        args: Array.isArray(config.args)
          ? config.args.map((item, index) => resolvePlaceholders(String(item), env, `${name}.args.${index}`))
          : [],
        env: Object.fromEntries(Object.entries(stringMapping(config.env))
          .map(([key, value]) => [key, resolvePlaceholders(value, env, `${name}.env.${key}`)])),
        cwd: resolvePlaceholders(String(config.cwd ?? "").trim(), env, `${name}.cwd`) || defaultCwd,
        url: resolvePlaceholders(String(config.url ?? "").trim(), env, `${name}.url`),
        headers,
        envHeaders: stringMapping(config.env_headers ?? config.envHeaders),
        bearerTokenEnvVar: String(config.bearer_token_env_var ?? config.bearerTokenEnvVar ?? "").trim(),
        connectorId: String(config.connector_id ?? config.connectorId ?? name).trim() || name,
        connectorName: String(config.connector_name ?? config.connectorName ?? name).trim() || name,
        connectorDescription: String(config.connector_description ?? config.connectorDescription ?? "").trim(),
        startupTimeoutMs: seconds(config.startup_timeout_s ?? config.startupTimeoutS, 10),
        toolTimeoutMs: seconds(config.tool_timeout_s ?? config.toolTimeoutS, 60),
        enabledTools: stringSet(config.enabled_tools ?? config.enabledTools),
        disabledTools: stringSet(config.disabled_tools ?? config.disabledTools),
        exposure: parseExposure(config.exposure, name),
      };
    }),
  };
}

export function addMcpServer(path: string, name: string, definition: Record<string, unknown>, env: Environment, defaultCwd: string, replace = false): McpServerConfig {
  const root = readOrEmpty(path);
  const key = root.mcpServers !== undefined ? "mcpServers" : "servers";
  const servers = mapping(root[key]);
  if (!replace && Object.hasOwn(servers, name)) throw new Error(`MCP server already exists: ${name}`);
  root[key] = { ...servers, [name]: { exposure: "codemode", ...definition, enabled: true } };
  const server = parseMcpConfig(root, env, defaultCwd).servers.find(item => item.name === name)!;
  writeMcpConfigDocument(path, root);
  return server;
}

/** Remove only the user configuration; OAuth credentials have their own lifecycle. */
export function removeMcpServer(path: string, name: string): void {
  const root = readOrEmpty(path);
  const servers = mapping(root.mcpServers ?? root.servers);
  if (!Object.hasOwn(servers, name)) throw new Error("MCP server not found: " + name);
  delete servers[name];
  writeMcpConfigDocument(path, root);
}

export function setMcpServerEnabled(path: string, serverName: string, enabled: boolean): void {
  const root = readMcpConfigDocument(path);
  const rootKey = root.mcpServers !== undefined ? "mcpServers" : "servers";
  const servers = mapping(root[rootKey]);
  const server = mapping(servers[serverName]);
  if (Object.keys(server).length === 0) throw new Error(`MCP server not found: ${serverName}`);
  server.enabled = enabled;
  servers[serverName] = server;
  root[rootKey] = servers;
  writeMcpConfigDocument(path, root);
}

export const usesMcpOAuth = (server: McpServerConfig): boolean =>
  server.transport === "streamable-http" && !server.bearerTokenEnvVar &&
  !new Headers(server.headers).has("authorization") && !new Headers(server.envHeaders).has("authorization");

export const resolveMcpHttpHeaders = (server: McpServerConfig, env: Environment): Record<string, string> => {
  const headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [
    key,
    resolvePlaceholders(value, env, `${server.name}.headers.${key}`),
  ]));
  for (const [header, envName] of Object.entries(server.envHeaders)) {
    const value = String(env[envName] ?? "").trim();
    if (!value) throw new Error(`missing environment variable ${envName} for MCP ${server.name}.envHeaders.${header}`);
    headers[header] = value;
  }
  if (server.bearerTokenEnvVar) {
    const token = String(env[server.bearerTokenEnvVar] ?? "").trim();
    if (!token) throw new Error(`missing environment variable ${server.bearerTokenEnvVar} for MCP ${server.name}.bearerTokenEnvVar`);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};
