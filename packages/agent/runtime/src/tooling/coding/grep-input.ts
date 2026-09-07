import type { JsonObject } from "@lxe/protocol";
import type { GrepOutputMode } from "../workspace-search";

export interface GrepInput {
  pattern: string;
  path: string;
  glob: string;
  type: string;
  output_mode: GrepOutputMode;
  literal: boolean;
  case_insensitive: boolean;
  multiline: boolean;
  head_limit: number;
  context?: number;
  before_context?: number;
  after_context?: number;
}

const modes = ["files_with_matches", "content", "count"];
const booleanKeys = ["literal", "case_insensitive", "multiline"] as const;
const contextKeys = ["context", "before_context", "after_context"] as const;
const nonNegativeInteger = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const properties = {
  pattern: { type: "string", minLength: 1, description: "Regex by default; with literal=true, search this exact text. A literal LF requires multiline=true." },
  path: { type: "string", minLength: 1, pattern: "\\S" },
  glob: { type: "string" },
  type: { type: "string" },
  output_mode: { type: "string", enum: modes, default: "files_with_matches" },
  literal: { type: "boolean", default: false },
  case_insensitive: { type: "boolean", default: false },
  multiline: { type: "boolean", default: false },
  head_limit: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 100, description: "Maximum output lines, including context lines." },
  context: nonNegativeInteger,
  before_context: { ...nonNegativeInteger, description: "Overrides context before matches, including when zero." },
  after_context: { ...nonNegativeInteger, description: "Overrides context after matches, including when zero." },
};

export const grepSchema: JsonObject = {
  type: "object", properties, required: ["pattern"], additionalProperties: false,
  allOf: [{
    if: { properties: { literal: { const: true }, pattern: { pattern: "\n" } }, required: ["literal", "pattern"] },
    then: { properties: { multiline: { const: true } }, required: ["multiline"] },
  }],
};

export function validateGrepInput(value: unknown): GrepInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("grep input must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(properties, key)) throw new Error(`grep unknown parameter: ${key}.`);
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) throw new Error("grep pattern must be a non-empty string.");
  if ("path" in input && (typeof input.path !== "string" || !input.path.trim())) throw new Error("grep path must be a non-empty, non-blank string.");
  for (const key of ["glob", "type"] as const) {
    if (key in input && typeof input[key] !== "string") throw new Error(`grep ${key} must be a string.`);
  }
  if ("output_mode" in input && (typeof input.output_mode !== "string" || !modes.includes(input.output_mode))) {
    throw new Error("grep output_mode must be files_with_matches, content or count.");
  }
  for (const key of booleanKeys) {
    if (key in input && typeof input[key] !== "boolean") throw new Error(`grep ${key} must be a boolean.`);
  }
  for (const key of ["head_limit", ...contextKeys] as const) {
    const minimum = key === "head_limit" ? 1 : 0;
    if (key in input && (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] < minimum)) {
      throw new Error(`grep ${key} must be a ${minimum ? "positive" : "non-negative"} safe integer.`);
    }
  }
  if (input.literal === true && input.pattern.includes("\n") && input.multiline !== true) {
    throw new Error("grep pattern contains a literal LF; set multiline=true.");
  }
  // Every provided field has been validated; defaults apply only to omitted fields.
  return {
    path: ".", glob: "", type: "", output_mode: "files_with_matches",
    literal: false, case_insensitive: false, multiline: false, head_limit: 100,
    ...input,
  } as GrepInput;
}
