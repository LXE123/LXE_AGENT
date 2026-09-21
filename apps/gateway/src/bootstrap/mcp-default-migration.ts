import { parseDocument } from "yaml";

export const SAIHU_CLOUD_MCP_URL = "http://10.88.0.1:8000/mcp/";
export const SAIHU_MCP_BEARER_ENV = "LXE_SAIHU_MCP_API_KEY";
const officialUrls = new Set([SAIHU_CLOUD_MCP_URL, "http://127.0.0.1:8000/mcp/", "http://localhost:8000/mcp/"]);
const legacyVariables = new Set(["LXE_DATA_SERVER_API_KEY", SAIHU_MCP_BEARER_ENV]);
const legacyHeaders = new Set([...legacyVariables].map(name => "Bearer ${" + name + "}"));
const mapping = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only migrate recognized shipped auth. Never print custom credentials in warnings. */
export function migrateSaihuMcpDefault(source: string, warn?: (message: string) => void): string | undefined {
  const document = parseDocument(source);
  if (document.errors.length > 0) { warn?.("赛狐 MCP 配置无法解析，请核实；未自动修改。"); return undefined; }
  const root = mapping(document.toJS());
  const server = mapping(mapping(root.mcpServers ?? root.servers)["lxe-saihu"]);
  if (!Object.keys(server).length) return undefined;
  const custom = () => { warn?.("赛狐 MCP 存在自定义地址或鉴权，请核实设备鉴权配置；原配置已保留。"); return undefined; };
  if (!officialUrls.has(String(server.url ?? "")) || (server.type && server.type !== "streamable-http")) return custom();
  const headers = Object.entries(mapping(server.headers));
  const authorization = headers.filter(([key]) => key.toLowerCase() === "authorization");
  const native = headers.filter(([key]) => key.toLowerCase() === "x-lxe-client");
  if (authorization.length > 1 || native.length > 1 || headers.some(([key]) => /^(cookie|proxy-authorization)$/iu.test(key))
    || Object.keys(mapping(server.env_headers ?? server.envHeaders)).length > 0) return custom();
  const bearer = String(server.bearer_token_env_var ?? server.bearerTokenEnvVar ?? "");
  if (server.bearerTokenEnvVar !== undefined || (bearer && !legacyVariables.has(bearer))
    || (authorization.length > 0 && !legacyHeaders.has(String(authorization[0]![1])))
    || (native.length > 0 && native[0]![1] !== "cli")) return custom();
  if (native.length === 1 && !bearer && authorization.length === 0 && server.url === SAIHU_CLOUD_MCP_URL) return undefined;
  if (!bearer && !authorization.length && !native.length) return custom();
  const path = [root.mcpServers ? "mcpServers" : "servers", "lxe-saihu"];
  document.setIn([...path, "url"], SAIHU_CLOUD_MCP_URL);
  document.deleteIn([...path, "bearer_token_env_var"]);
  for (const [key] of [...authorization, ...native]) document.deleteIn([...path, "headers", key]);
  document.setIn([...path, "headers", "X-LXE-Client"], "cli");
  return document.toString();
}
