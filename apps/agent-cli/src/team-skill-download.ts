import { createHash } from "node:crypto";
import { harnessFetch, McpLoginRequired, OfficialMcpConnector, type McpConfig, type McpConnection } from "@lxe/runtime";
import { TEAM_SKILLS_MCP_URL } from "@lxe/desktop-protocol/team-skills";
import { mcpServerEnabledOnPlatform } from "./mcp-server-directory";
import type { McpAuthStore } from "./mcp-auth-store";

export const MAX_TEAM_ZIP = (10 * 1024 + 128) * 1024;
async function tool(connection: McpConnection, name: string, args: { id: string; version?: string }, signal: AbortSignal) {
  const result = await connection.callTool(name, args, signal);
  const text = result.content.find(item => typeof item.text === "string")?.text;
  if (result.isError) throw new Error(typeof text === "string" ? text : `${name} failed`);
  const value: unknown = result.structuredContent ?? (typeof text === "string" ? JSON.parse(text) : undefined);
  if (!value || typeof value !== "object") throw new Error(`Invalid ${name} response`);
  return value as Record<string, unknown>;
}

export async function readTeamZip(response: Response, size: number, sha256: string): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_TEAM_ZIP || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("无效的技能包大小或 SHA-256");
  if (!response.ok || !response.body) throw new Error(`技能包下载失败 (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > size) throw new Error("技能包大小超出下载凭据");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (length !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("技能包大小或 SHA-256 校验失败");
  return bytes;
}

export function teamSkillDownloader(config: () => McpConfig, auth: McpAuthStore, environment: Record<string, string | undefined>) {
  const connector = new OfficialMcpConnector(environment, undefined, (name, url, rejected) => auth.token(name, url, rejected));
  return async (id: string, version: string) => {
    const server = config().servers.find(item => item.name === "team-skills");
    if (!server || !mcpServerEnabledOnPlatform(server, "desktop") || server.transport !== "streamable-http" || server.url !== TEAM_SKILLS_MCP_URL)
      throw new Error("请在 LXE 中启用团队技能库的 team-skills MCP 连接");
    for (const name of ["team_skills_detail", "team_skills_download"]) {
      if (server.disabledTools.has(name) || (server.enabledTools.size && !server.enabledTools.has(name))) throw new Error(`MCP 工具已禁用：${name}`);
    }
    const signal = AbortSignal.timeout(60_000);
    let connection: McpConnection | undefined;
    try {
      connection = await connector.connect(server, signal);
      const detail = await tool(connection, "team_skills_detail", { id }, signal);
      if (detail.id !== id || detail.status !== "published" || detail.version !== version) throw new Error("团队技能已变更，请刷新卡片后重试");
      const ticket = await tool(connection, "team_skills_download", { id, version }, signal);
      const url = typeof ticket.downloadUrl === "string" && URL.parse(ticket.downloadUrl);
      if (!url || url.protocol !== "https:" || url.username || url.password || ticket.version !== version ||
        typeof ticket.size !== "number" || ticket.size > MAX_TEAM_ZIP || typeof ticket.sha256 !== "string" ||
        ticket.sha256 !== detail.sha256 || ticket.size !== detail.size) throw new Error("团队技能下载凭据与发布记录不符");
      const response = await harnessFetch(url, { signal, redirect: "error" }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message.replace(/https?:\/\/[^\s"']+/g, "[签名地址]") : "网络请求失败";
        throw new Error("下载 ZIP 失败：" + reason);
      });
      return await readTeamZip(response, ticket.size, ticket.sha256);
    } catch (error) {
      if (error instanceof McpLoginRequired) throw new Error("请先在 LXE 的 MCP 连接中登录 team-skills，再重试安装。", { cause: error });
      throw error;
    } finally { await connection?.close(); }
  };
}
