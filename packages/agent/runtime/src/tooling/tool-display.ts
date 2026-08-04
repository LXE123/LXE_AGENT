import { basename, isAbsolute } from "node:path";
import type { JsonObject, ToolDisplayBlock, ToolStep } from "@lxe/protocol";
import { matchLxeSkillInvocation } from "./lxeskill-command";

const DETAIL_LIMIT = 240;
const RESULT_LIMIT = 4_000;
const ERROR_LIMIT = 2_000;
const SECRET_NAME = /token|secret|password|api[-_]?key|authorization|cookie|credential|bearer|session[-_]?id|client[-_]?secret|access[-_]?key/i;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp|private|Volumes|opt|usr)\/)[^\s"'`,;:)]*/g;

const scalar = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim()
    : "";

const truncate = (value: string, limit = DETAIL_LIMIT): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;

const sanitize = (value: unknown, showFullPaths = false, limit = DETAIL_LIMIT, preserveLines = false): string => {
  let text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!preserveLines) text = text.replace(/\s+/g, " ");
  text = text.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
  text = text.replace(/([?&])(api_key|token|secret|key|authorization|cookie)=[^&\s]*/gi, "$1$2=[redacted]");
  text = text.replace(/(["']?(?:token|secret|password|api[-_]?key|authorization|cookie|credential)["']?\s*:\s*["'])[^"']+(["'])/gi, "$1[redacted]$2");
  text = text.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^'"\s]+/gi, "$1[redacted]");
  text = text.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)(=)([^\s]+)/g, (match, prefix, name, separator) =>
    SECRET_NAME.test(String(name)) ? `${prefix}${name}${separator}[redacted]` : match);
  text = text.replace(/(^|\s)(--?[A-Za-z0-9][A-Za-z0-9-]*)(=|\s+)([^\s]+)/g, (match, prefix, flag, separator) =>
    SECRET_NAME.test(String(flag)) ? `${prefix}${flag}${separator}[redacted]` : match);
  if (!showFullPaths) text = text.replace(ABSOLUTE_PATH, (path) => `.../${basename(path.replaceAll("\\", "/")) || "path"}`);
  return truncate(text, limit);
};

const humanize = (name: string): string =>
  name.split(/[_\-\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ") || "Tool";

const descriptors: Record<string, { title: string; icon: string; keys: string[] }> = {
  read: { title: "Read", icon: "file-link-text_outlined", keys: ["path", "file_path"] },
  write: { title: "Write", icon: "edit_outlined", keys: ["file_path", "path"] },
  edit: { title: "Edit", icon: "edit_outlined", keys: ["file_path", "path"] },
  grep: { title: "Search text", icon: "doc-search_outlined", keys: ["pattern", "path"] },
  find: { title: "Search files", icon: "folder_outlined", keys: ["pattern", "path"] },
  ls: { title: "List files", icon: "folder_outlined", keys: ["path"] },
  send_files: { title: "Send files", icon: "file-link-text_outlined", keys: ["paths"] },
  // Retained for rendering historical transcript entries after the model tool was renamed.
  send_file: { title: "Send file", icon: "file-link-text_outlined", keys: ["path"] },
  exec: { title: "Run command", icon: "setting_outlined", keys: ["command"] },
  process: { title: "Process", icon: "setting-inter_outlined", keys: ["action", "session"] },
  web_search: { title: "Search web", icon: "search_outlined", keys: ["query"] },
  web_fetch: { title: "Fetch web page", icon: "language_outlined", keys: ["url"] },
  feishu_im_bot_list_groups: { title: "List Feishu groups", icon: "list-check_outlined", keys: ["page_size"] },
  feishu_im_bot_get_messages: { title: "Read Feishu messages", icon: "file-link-text_outlined", keys: ["relative_time", "start_time", "chat_id"] },
  feishu_im_bot_get_thread_messages: { title: "Read Feishu thread", icon: "file-link-text_outlined", keys: ["thread_id"] },
  feishu_im_bot_fetch_resource: { title: "Fetch Feishu resource", icon: "language_outlined", keys: ["type", "message_id"] },
  ziniao_browser: { title: "Ziniao browser", icon: "browser-mac_outlined", keys: ["action", "store_id"] },
  ziniao_page: { title: "Ziniao page", icon: "browser-mac_outlined", keys: ["action", "store_id"] },
};

const stringifyDisplay = (value: unknown, limit: number, showFullPaths: boolean): ToolDisplayBlock | undefined => {
  if (value === undefined || value === null) return undefined;
  let language: ToolDisplayBlock["language"] = "text";
  let content = "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        language = "json";
        content = JSON.stringify(parsed, null, 2);
      } else content = trimmed;
    } catch {
      content = trimmed;
    }
  } else if (typeof value === "object") {
    language = "json";
    try { content = JSON.stringify(value, null, 2); } catch { content = String(value); }
  } else content = String(value);
  content = sanitize(content, showFullPaths, limit, true);
  return content ? { language, content } : undefined;
};

export function buildToolDisplayStep(
  id: string,
  name: string,
  input: JsonObject,
  status: ToolStep["status"],
  durationMs: number,
  options: {
    showFullPaths?: boolean;
    result?: unknown;
    error?: unknown;
    showResultDetails?: boolean;
  } = {},
): ToolStep {
  const safeName = String(name || "tool").trim() || "tool";
  const isExec = safeName.toLowerCase() === "exec";
  const businessInvocation = isExec
    ? matchLxeSkillInvocation(input.command)
    : undefined;
  const descriptor = businessInvocation
    ? { title: `业务技能：${businessInvocation.commandId}`, icon: "setting_outlined", keys: ["command"] }
    : descriptors[safeName.toLowerCase()] ?? {
    title: humanize(safeName),
    icon: "setting-inter_outlined",
    keys: ["action", "path", "file_path", "command", "query", "url", "description", "target"],
  };
  const detail = descriptor.keys.map((key) => {
    const value = input[key];
    if (safeName.toLowerCase() === "send_files" && key === "paths" && Array.isArray(value)) {
      return value.map((item) => scalar(item)).filter(Boolean).join("\n");
    }
    return scalar(value);
  }).filter(Boolean).join(" ");
  const showFullPaths = options.showFullPaths === true;
  // The command is reader-visible execution state, just like the persisted
  // tool call shown after the turn. Keep it byte-for-byte apart from trimming
  // surrounding whitespace so live and historical views do not disagree.
  const safeDetail = isExec
    ? detail
    : safeName.toLowerCase() === "send_files"
    ? sanitize(detail, showFullPaths)
    : isAbsolute(detail) && !showFullPaths
      ? `.../${basename(detail) || "path"}`
      : sanitize(detail, showFullPaths);
  const resultBlock = status === "success" && options.showResultDetails
    ? stringifyDisplay(options.result, RESULT_LIMIT, showFullPaths)
    : undefined;
  const errorBlock = status === "error"
    ? stringifyDisplay(options.error, ERROR_LIMIT, showFullPaths)
    : undefined;
  return {
    id: String(id ?? "").trim(),
    name: safeName,
    title: descriptor.title,
    detail: safeDetail,
    icon_token: descriptor.icon,
    status,
    duration_ms: Math.max(0, Math.trunc(durationMs)),
    ...(resultBlock ? { result_block: resultBlock } : {}),
    ...(errorBlock ? { error_block: errorBlock } : {}),
  };
}
