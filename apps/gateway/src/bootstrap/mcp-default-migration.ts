import { isMap, parseDocument } from "yaml";

const OLD_LOCAL_URLS = new Set([
  "http://127.0.0.1:8000/mcp/",
  "http://localhost:8000/mcp/",
]);
const OLD_BEARER_ENV = "LXE_DATA_SERVER_API_KEY";
const OLD_AUTHORIZATION = "Bearer ${LXE_DATA_SERVER_API_KEY}";

export const SAIHU_CLOUD_MCP_URL = "http://10.88.0.1:8000/mcp/";
export const SAIHU_MCP_BEARER_ENV = "LXE_SAIHU_MCP_API_KEY";

const mapping = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Migrate only the exact historical lxe-saihu endpoint and auth defaults. */
export function migrateSaihuMcpDefault(source: string): string | undefined {
  const document = parseDocument(source);
  if (document.errors.length > 0) return undefined;
  const root = mapping(document.toJS());
  const servers = mapping(root.mcpServers ?? root.servers);
  const server = mapping(servers["lxe-saihu"]);
  if (!OLD_LOCAL_URLS.has(String(server.url ?? ""))) return undefined;

  const headers = mapping(server.headers);
  const authorizationEntry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "authorization",
  );
  const authorization = String(authorizationEntry?.[1] ?? "");
  const bearerEnvironment = String(server.bearer_token_env_var ?? "");
  const usesOldBearer = bearerEnvironment === OLD_BEARER_ENV
    && (!authorization || authorization === OLD_AUTHORIZATION);
  const usesOldHeader = !bearerEnvironment && authorization === OLD_AUTHORIZATION;
  if (!usesOldBearer && !usesOldHeader) return undefined;

  const rootName = root.mcpServers ? "mcpServers" : "servers";
  const serverPath = [rootName, "lxe-saihu"];
  document.setIn([...serverPath, "url"], SAIHU_CLOUD_MCP_URL);
  document.setIn(
    [...serverPath, "bearer_token_env_var"],
    SAIHU_MCP_BEARER_ENV,
  );
  if (authorizationEntry?.[0] && authorization === OLD_AUTHORIZATION) {
    document.deleteIn([...serverPath, "headers", authorizationEntry[0]]);
    const headersNode = document.getIn([...serverPath, "headers"], true);
    if (isMap(headersNode) && headersNode.items.length === 0) {
      document.deleteIn([...serverPath, "headers"]);
    }
  }
  return document.toString();
}
