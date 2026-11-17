import { createHash } from "node:crypto";
import { harnessFetch } from "@lxe/runtime";
import { MAX_TEAM_ZIP, parseTeamInstallTicket, type TeamInstallTicket } from "@lxe/desktop-protocol/team-skills";

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

export async function downloadTeamSkill(raw: TeamInstallTicket): Promise<Buffer> {
  const ticket = parseTeamInstallTicket(raw);
  try {
    const response = await harnessFetch(ticket.downloadUrl, {
      signal: AbortSignal.timeout(60_000), redirect: "error", credentials: "omit",
    });
    return await readTeamZip(response, ticket.size, ticket.sha256);
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/https?:\/\/[^\s"']+/gi, "[签名地址]") : "网络请求失败";
    throw new Error("下载 ZIP 失败：" + reason);
  }
}
