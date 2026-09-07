import type { JsonObject } from "@lxe/protocol";

export interface TextEdit { oldText: string; newText: string }
export interface EditInput { path: string; edits: TextEdit[] }

export const editInputSchema: JsonObject = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, pattern: "\\S", description: "File path, relative to the session directory or absolute." },
    edits: {
      type: "array", minItems: 1,
      description: "Disjoint replacements matched against the same original file. Merge overlapping changes into one edit.",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string", minLength: 1, description: "Original text; must identify one unique location." },
          newText: { type: "string", description: "Literal replacement text; empty string deletes the target." },
        },
        required: ["oldText", "newText"], additionalProperties: false,
      },
    },
  },
  required: ["path", "edits"], additionalProperties: false,
};

const example = 'Use {"path":"src/app.ts","edits":[{"oldText":"before","newText":"after"}]}.';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateEditInput(value: unknown): EditInput {
  if (!object(value)) throw new Error(`edit input must be an object. ${example}`);
  if (["file_path", "old_string", "new_string", "replace_all"].some((key) => key in value)) {
    throw new Error(`Legacy edit arguments are no longer supported. ${example}`);
  }
  if (Object.keys(value).some((key) => key !== "path" && key !== "edits")) {
    throw new Error(`edit input contains unknown fields. ${example}`);
  }
  if (typeof value.path !== "string" || !value.path.trim()) throw new Error(`edit path must be a non-empty string. ${example}`);
  if (!Array.isArray(value.edits) || value.edits.length === 0) throw new Error(`edit edits must be a non-empty array. ${example}`);
  const edits = value.edits.map((edit: unknown, index: number): TextEdit => {
    if (!object(edit) || Object.keys(edit).some((key) => key !== "oldText" && key !== "newText")) {
      throw new Error(`edits[${index}] must contain only oldText and newText. ${example}`);
    }
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) throw new Error(`edits[${index}].oldText must be a non-empty string.`);
    if (typeof edit.newText !== "string") throw new Error(`edits[${index}].newText must be a string; use "" to delete.`);
    return { oldText: edit.oldText, newText: edit.newText };
  });
  return { path: value.path, edits };
}

const normalizeLF = (text: string): string => text.replace(/\r\n|\r/g, "\n");

// Match PI's normalization policy; never apply this to replacement text.
export const normalizeEditMatch = (text: string): string => text.normalize("NFKC")
  .split("\n").map((line) => line.trimEnd()).join("\n")
  .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, "-")
  .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");

interface Match { index: number; start: number; end: number; newText: string }
interface Line { start: number; end: number; text: string }
interface Change { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
export interface PreparedTextEdit {
  content: string;
  firstChangedLine: number;
  fuzzyEdits: number[];
  oldLines: string[];
  newLines: string[];
  changes: Change[];
  lineEndingNote?: string;
}

const linesOf = (text: string): Line[] => {
  let start = 0;
  return (text.match(/[^\n]*\n|[^\n]+/g) ?? []).map((text) => {
    const line = { start, end: start + text.length, text };
    start = line.end;
    return line;
  });
};

const lineAt = (lines: Line[], offset: number): number => {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid]!.end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
};

export function prepareTextEdit(source: string, edits: TextEdit[]): PreparedTextEdit {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const raw = source.slice(bom.length);
  const ending = raw.match(/\r\n|\r|\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
  const original = normalizeLF(raw);
  const normalized = normalizeEditMatch(original);
  const targets = edits.map((edit, index) => {
    const oldText = normalizeLF(edit.oldText);
    const fuzzyText = normalizeEditMatch(oldText);
    if (!fuzzyText) throw new Error(`edits[${index}].oldText is empty after normalization.`);
    return { oldText, fuzzyText, newText: normalizeLF(edit.newText) };
  });
  const fuzzyEdits = targets.flatMap((target, index) => original.includes(target.oldText) ? [] : [index]);
  const base = fuzzyEdits.length > 0 ? normalized : original;
  const matches: Match[] = targets.map((target, index) => {
    const needle = fuzzyEdits.length > 0 ? target.fuzzyText : target.oldText;
    const start = base.indexOf(needle);
    if (start < 0) throw new Error(`edits[${index}].oldText not found, including normalized matching.`);
    const normalizedStart = normalized.indexOf(target.fuzzyText);
    // Include overlapping occurrences (e.g. "aa" in "aaa") in ambiguity checks.
    if (normalized.indexOf(target.fuzzyText, normalizedStart + 1) >= 0) {
      throw new Error(`edits[${index}].oldText is not unique after normalization; provide more context.`);
    }
    return { index, start, end: start + needle.length, newText: target.newText };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < matches.length; index++) {
    const previous = matches[index - 1]!;
    const current = matches[index]!;
    if (previous.end > current.start) throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap; merge them into one edit.`);
  }

  const originalLines = linesOf(original);
  const baseLines = linesOf(base);
  if (baseLines.length !== originalLines.length) {
    // trimEnd can erase the final whitespace-only, unterminated line.
    if (baseLines.length + 1 === originalLines.length && originalLines.at(-1)!.text.trim() === "") {
      baseLines.push({ start: base.length, end: base.length, text: "" });
    } else throw new Error("Normalized text changed the line structure; use exact text with more context.");
  }
  const groups: Array<{ start: number; end: number; matches: Match[] }> = [];
  for (const match of matches) {
    const start = lineAt(baseLines, match.start);
    const touchedEnd = lineAt(baseLines, match.end - 1) + 1;
    const previous = groups.at(-1);
    if (previous && start < previous.end) {
      previous.end = Math.max(previous.end, touchedEnd);
      previous.matches.push(match);
    } else groups.push({ start, end: touchedEnd, matches: [match] });
  }

  // Build actual changed line blocks. Include a following ORIGINAL line when a
  // removed newline joins it to a replacement, so summaries show the real lines.
  const chunks: string[] = [];
  const changes: Change[] = [];
  let cursor = 0;
  let newLineCursor = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]!;
    const startOffset = baseLines[group.start]!.start;
    let replacement = base.slice(startOffset, baseLines[group.end - 1]!.end);
    for (const match of [...group.matches].reverse()) {
      replacement = replacement.slice(0, match.start - startOffset) + match.newText + replacement.slice(match.end - startOffset);
    }
    // Adjacent edited groups can also join; compute them together on the next pass.
    if (replacement && !replacement.endsWith("\n") && group.end < originalLines.length) {
      const next = groups[groupIndex + 1];
      if (next && next.start === group.end) {
        group.end = next.end;
        group.matches.push(...next.matches);
        groups.splice(groupIndex + 1, 1);
        groupIndex--;
        continue;
      }
      replacement += originalLines[group.end]!.text;
      group.end++;
    }
    chunks.push(originalLines.slice(cursor, group.start).map((line) => line.text).join(""));
    newLineCursor += group.start - cursor;
    const oldBlock = originalLines.slice(group.start, group.end).map((line) => line.text);
    const newBlock = linesOf(replacement).map((line) => line.text);
    let prefix = 0;
    while (prefix < oldBlock.length && prefix < newBlock.length && oldBlock[prefix] === newBlock[prefix]) prefix++;
    let suffix = 0;
    while (suffix < oldBlock.length - prefix && suffix < newBlock.length - prefix
      && oldBlock[oldBlock.length - suffix - 1] === newBlock[newBlock.length - suffix - 1]) suffix++;
    if (prefix + suffix < oldBlock.length || prefix + suffix < newBlock.length) {
      changes.push({ oldStart: group.start + prefix, oldEnd: group.end - suffix,
        newStart: newLineCursor + prefix, newEnd: newLineCursor + newBlock.length - suffix });
    }
    chunks.push(replacement);
    newLineCursor += newBlock.length;
    cursor = group.end;
  }
  chunks.push(originalLines.slice(cursor).map((line) => line.text).join(""));
  const updated = chunks.join("");
  const content = bom + (ending === "\r\n" ? updated.replaceAll("\n", "\r\n") : updated);
  if (content === source) throw new Error("No changes made: 未产生修改.");
  const lineEndingChanged = raw !== (ending === "\r\n" ? original.replaceAll("\n", "\r\n") : original);
  const firstEndingChange = lineEndingChanged
    ? (raw.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []).findIndex((line) => {
      const eol = line.match(/\r\n$|\r$|\n$/)?.[0];
      return eol !== undefined && eol !== ending;
    }) + 1 : Infinity;
  return {
    content, fuzzyEdits,
    firstChangedLine: Math.min(changes[0]?.newStart === undefined ? Infinity : changes[0].newStart + 1, firstEndingChange),
    oldLines: originalLines.map((line) => line.text), newLines: linesOf(updated).map((line) => line.text), changes,
    ...(lineEndingChanged ? { lineEndingNote: `Line endings normalized throughout the file to ${ending === "\r\n" ? "CRLF" : "LF"}.` } : {}),
  };
}

export function summarizeTextEdit(path: string, editCount: number, result: PreparedTextEdit, limit: number): string {
  const notice = "... (Diff summary truncated; use read with offset/limit to inspect the edited file.)";
  const output: string[] = [];
  let length = 0;
  const add = (line: string): boolean => {
    if (length + line.length + 1 > limit - notice.length - 1) return false;
    output.push(line);
    length += line.length + 1;
    return true;
  };
  const rows = function* (): Generator<string> {
    yield `Edited ${path}: ${editCount} replacement(s); first changed line ${result.firstChangedLine}.`;
    if (result.fuzzyEdits.length) {
      yield "Normalized matching used; touched lines may also contain normalized characters:";
      for (let i = 0; i < result.fuzzyEdits.length; i += 20) yield result.fuzzyEdits.slice(i, i + 20).map((index) => `edits[${index}]`).join(", ");
    }
    if (result.lineEndingNote) yield result.lineEndingNote;
    const line = function* (prefix: string, number: number, text: string): Generator<string> {
      yield `${prefix}${number} ${text.endsWith("\n") ? text.slice(0, -1) : text}`;
      if (!text.endsWith("\n")) yield "\\ No newline at end of file";
    };
    let cursor = -1;
    for (let i = 0; i < result.changes.length; i++) {
      const change = result.changes[i]!;
      const start = Math.max(0, change.oldStart - 3);
      if (cursor < start) { yield "@@"; cursor = start; }
      for (; cursor < change.oldStart; cursor++) yield* line(" ", cursor + 1, result.oldLines[cursor]!);
      for (; cursor < change.oldEnd; cursor++) yield* line("-", cursor + 1, result.oldLines[cursor]!);
      for (let n = change.newStart; n < change.newEnd; n++) yield* line("+", n + 1, result.newLines[n]!);
      const next = result.changes[i + 1];
      const contextEnd = Math.min(result.oldLines.length, change.oldEnd + 3, next?.oldStart ?? Infinity);
      for (; cursor < contextEnd; cursor++) yield* line(" ", cursor + 1, result.oldLines[cursor]!);
    }
  };
  for (const row of rows()) {
    if (!add(row)) { output.push(notice); break; }
  }
  return output.join("\n");
}
