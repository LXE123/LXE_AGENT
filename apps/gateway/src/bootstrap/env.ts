import { readFileSync } from "node:fs";

export type Environment = Record<string, string>;

export const DEVELOPMENT_SECRET_ENV_NAMES = new Set([
  "DEEPSEEK_API",
  "KIMI_CODE_API_KEY",
  "GLM_API_KEY",
  "FEISHU_APP_SECRET",
  "MABANG_PASSWORD",
  "ZINIAO_PASSWORD",
  "LXE_DATA_SERVER_API_KEY",
  "LXE_DATA_SERVER_FALLBACK_API_KEY",
  "LXE_ERP_API_KEY",
]);

export interface EnvironmentFilesOptions {
  paths: readonly string[];
  initial?: Readonly<Record<string, string | undefined>>;
  readFile?: (path: string) => string | undefined;
}

const validEnvName = (name: string): boolean => {
  const withoutUnderscores = name.replaceAll("_", "");
  return (
    withoutUnderscores.length > 0 &&
    !/^\p{N}/u.test(name) &&
    /^[\p{L}\p{N}_]+$/u.test(name)
  );
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed[0] === trimmed[trimmed.length - 1] &&
    (trimmed[0] === '"' || trimmed[0] === "'")
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed[0] === '"'
      ? inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t")
      : inner;
  }
  return trimmed;
};

export function parseEnvFile(content: string): Array<[string, string]> {
  const assignments: Array<[string, string]> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (!validEnvName(name)) continue;
    assignments.push([name, unquote(line.slice(separator + 1))]);
  }
  return assignments;
}

const defaultReadFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return undefined;
    throw error;
  }
};

/** Legacy/import-only dotenv reader. Runtime composition must consume the resolved environment. */
export function loadEnvironmentFiles(options: EnvironmentFilesOptions): Environment {
  const result: Environment = {};
  for (const [name, value] of Object.entries(options.initial ?? process.env)) {
    if (value !== undefined) result[name] = value;
  }
  const readFile = options.readFile ?? defaultReadFile;
  for (const path of options.paths) {
    const content = readFile(path);
    if (content === undefined) continue;
    for (const [name, value] of parseEnvFile(content)) {
      if (!(name in result)) result[name] = value;
    }
  }
  return result;
}

export function developmentSecretEnvironment(environment: Readonly<Record<string, string | undefined>>): Environment {
  const result: Environment = {};
  for (const name of DEVELOPMENT_SECRET_ENV_NAMES) {
    const value = environment[name];
    if (value !== undefined && value.trim()) result[name] = value;
  }
  return result;
}
