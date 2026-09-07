import { readdirSync, type Dirent } from "node:fs";
import type { JsonObject } from "@lxe/protocol";

export interface DirectoryListInput {
  path: string;
  limit: number;
  offset: number;
}

export const directoryListSchema: JsonObject = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, pattern: "\\S", description: "Directory path; defaults to the session working directory." },
    limit: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 500, description: "Maximum entries to return; the output character budget may stop the page earlier." },
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: "Number of sorted entries to skip. Use the next offset returned by the previous page." },
  },
  additionalProperties: false,
};

export function validateDirectoryListInput(value: unknown): DirectoryListInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("ls input must be an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["path", "limit", "offset"].includes(key))) throw new Error("ls accepts only path, limit and offset.");
  if ("path" in input && (typeof input.path !== "string" || !input.path.trim())) throw new Error("ls path must be a non-empty string.");
  const limit = "limit" in input ? input.limit : 500;
  const offset = "offset" in input ? input.offset : 0;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) throw new Error("ls limit must be a positive safe integer.");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("ls offset must be a non-negative safe integer.");
  return { path: typeof input.path === "string" ? input.path : ".", limit, offset };
}

type DirectoryEntry = Pick<Dirent, "name" | "isDirectory" | "isSymbolicLink">;

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

const displayName = (entry: DirectoryEntry): string => {
  const escaped = entry.name.replace(/[\\\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) => {
    switch (character) {
      case "\\": return "\\\\";
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      default: {
        const code = character.codePointAt(0)!;
        return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
      }
    }
  });
  return escaped + (entry.isSymbolicLink() ? "@" : entry.isDirectory() ? "/" : "");
};

/** Format a fresh listing; pagination is stable only while directory entries stay unchanged. */
export function formatDirectoryPage(
  entries: readonly DirectoryEntry[],
  { limit, offset }: Pick<DirectoryListInput, "limit" | "offset">,
  characterBudget: number,
): string {
  const bounded = (text: string): string => {
    if (text.length > characterBudget) throw new Error("ls output budget is too small for the page status.");
    return text;
  };
  const total = entries.length;
  if (total === 0) return bounded("Empty directory. Total entries: 0. End of directory.");
  if (offset >= total) return bounded(`No more entries at offset=${offset}. Total entries: ${total}. End of directory.`);

  const sorted = entries.map((entry) => ({ entry, folded: entry.name.toLowerCase() }))
    .sort((a, b) => compareText(a.folded, b.folded) || compareText(a.entry.name, b.entry.name));
  // Subtract before adding so even MAX_SAFE_INTEGER limits never overflow.
  const requestedEnd = offset + Math.min(limit, total - offset);
  const header = (end: number): string => `Showing entries ${offset + 1}–${end} of ${total}.`;
  const footer = (end: number, reason: "entry" | "character"): string => end === total
    ? "End of directory."
    : `${reason === "entry" ? "Entry limit" : "Output character limit"} reached. Continue with offset=${end}.`;
  const lines: string[] = [];
  let bodyLength = 0;
  let end = offset;
  let reason: "entry" | "character" = "entry";
  for (; end < requestedEnd; end++) {
    const line = displayName(sorted[end]!.entry);
    const candidateEnd = end + 1;
    // Reserve all framing before accepting a complete entry. If the requested
    // count is reached, the shorter entry-limit/end notice is already known.
    const candidateFooter = footer(candidateEnd, candidateEnd === requestedEnd ? "entry" : "character");
    const candidateLength = header(candidateEnd).length + 1 + bodyLength + line.length + 1 + candidateFooter.length;
    if (candidateLength > characterBudget) {
      if (lines.length === 0) throw new Error(`ls entry at offset=${offset} cannot fit in the output character budget (${characterBudget}) with page status; its name was not truncated or skipped.`);
      reason = "character";
      break;
    }
    lines.push(line);
    bodyLength += line.length + 1;
  }
  return bounded(`${header(end)}\n${lines.join("\n")}\n${footer(end, reason)}`);
}

export function listDirectory(path: string, input: DirectoryListInput, characterBudget: number, signal: AbortSignal): string {
  signal.throwIfAborted();
  const entries = readdirSync(path, { withFileTypes: true });
  signal.throwIfAborted();
  return formatDirectoryPage(entries, input, characterBudget);
}
