import { basename, isAbsolute } from "node:path";
import type { JsonObject, ToolStep } from "@lxe/protocol";

const DETAIL_LIMIT = 240;
const SECRET_NAME = /token|secret|password|api[-_]?key|authorization|cookie|credential|bearer|session[-_]?id|client[-_]?secret|access[-_]?key/i;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|private|Volumes|opt|usr)\/)[^\s"'`,;:)]*/g;

const scalar = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim()
    : "";

const truncate = (value: string): string =>
  value.length <= DETAIL_LIMIT ? value : `${value.slice(0, DETAIL_LIMIT - 3)}...`;

const sanitize = (value: unknown): string => {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  text = text.replace(/([?&])(api_key|token|secret|key|authorization|cookie)=[^&\s]*/gi, "$1$2=[redacted]");
  text = text.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^'"\s]+/gi, "$1[redacted]");
  text = text.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)(=)([^\s]+)/g, (match, prefix, name, separator) =>
    SECRET_NAME.test(String(name)) ? `${prefix}${name}${separator}[redacted]` : match);
  text = text.replace(/(^|\s)(--?[A-Za-z0-9][A-Za-z0-9-]*)(=|\s+)([^\s]+)/g, (match, prefix, flag, separator) =>
    SECRET_NAME.test(String(flag)) ? `${prefix}${flag}${separator}[redacted]` : match);
  text = text.replace(ABSOLUTE_PATH, (path) => `.../${basename(path.replaceAll("\\", "/")) || "path"}`);
  return truncate(text);
};

const humanize = (name: string): string =>
  name.split(/[_\-\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ") || "Tool";

const descriptors: Record<string, { title: string; keys: string[] }> = {
  read: { title: "Read", keys: ["path"] },
  write: { title: "Write", keys: ["file_path"] },
  edit: { title: "Edit", keys: ["file_path"] },
  ls: { title: "List files", keys: ["path"] },
  send_file: { title: "Send file", keys: ["path"] },
  exec: { title: "Run command", keys: ["command"] },
  process: { title: "Process", keys: ["action", "session"] },
  feishu_im_bot_list_groups: { title: "List Feishu groups", keys: ["page_size"] },
  feishu_im_bot_get_messages: { title: "Read Feishu messages", keys: ["relative_time", "start_time", "chat_id"] },
  feishu_im_bot_get_thread_messages: { title: "Read Feishu thread", keys: ["thread_id"] },
  feishu_im_bot_fetch_resource: { title: "Fetch Feishu resource", keys: ["type", "message_id"] },
  ziniao_browser: { title: "Ziniao browser", keys: ["action", "store_id"] },
  ziniao_page: { title: "Ziniao page", keys: ["action", "store_id"] },
};

export function buildToolDisplayStep(
  id: string,
  name: string,
  input: JsonObject,
  status: ToolStep["status"],
  durationMs: number,
): ToolStep {
  const safeName = String(name || "tool").trim() || "tool";
  const descriptor = descriptors[safeName.toLowerCase()] ?? {
    title: humanize(safeName),
    keys: ["action", "path", "file_path", "command", "query", "url", "description", "target"],
  };
  const detail = descriptor.keys.map((key) => scalar(input[key])).filter(Boolean).join(" ");
  const safeDetail = isAbsolute(detail) ? `.../${basename(detail) || "path"}` : sanitize(detail);
  return {
    id: String(id ?? "").trim(),
    name: safeName,
    title: descriptor.title,
    detail: safeDetail,
    status,
    duration_ms: Math.max(0, Math.trunc(durationMs)),
  };
}
