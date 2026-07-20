import { join } from "node:path";
import { readFileSync } from "node:fs";

export type Environment = Record<string, string>;

export interface ProjectEnvOptions {
  projectRoot: string;
  initial?: Readonly<Record<string, string | undefined>>;
  readFile?: (path: string) => string | undefined;
}

export interface RuntimeEnvOptions {
  runtimeEnvPath: string;
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

export function loadProjectEnv(options: ProjectEnvOptions): Environment {
  const result: Environment = {};
  for (const [name, value] of Object.entries(options.initial ?? process.env)) {
    if (value !== undefined) result[name] = value;
  }
  const readFile = options.readFile ?? defaultReadFile;
  const paths = [
    join(options.projectRoot, ".env"),
    join(options.projectRoot, ".env.local"),
    join(options.projectRoot, "config", "runtime.env"),
  ];
  for (const path of paths) {
    const content = readFile(path);
    if (content === undefined) continue;
    for (const [name, value] of parseEnvFile(content)) {
      if (!(name in result)) result[name] = value;
    }
  }
  return result;
}

export function loadRuntimeEnv(options: RuntimeEnvOptions): Environment {
  const result: Environment = {};
  for (const [name, value] of Object.entries(options.initial ?? process.env)) {
    if (value !== undefined) result[name] = value;
  }
  const content = (options.readFile ?? defaultReadFile)(options.runtimeEnvPath);
  if (content === undefined) return result;
  for (const [name, value] of parseEnvFile(content)) {
    if (!(name in result)) result[name] = value;
  }
  return result;
}
