export type Environment = Readonly<Record<string, string | undefined>>;

/** Prepare the app's managed Python processes without inheriting another install's settings. */
export function managedPythonEnvironment(env: Environment): Record<string, string | undefined> {
  const result = { ...env };
  // Match case-insensitively for Windows. Removing the whole namespace also
  // prevents PYTHONINSPECT/PYTHONUSERBASE/etc. from changing controlled launches.
  for (const key of Object.keys(result)) {
    if (key.toUpperCase().startsWith("PYTHON")) delete result[key];
  }
  return {
    ...result,
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1",
  };
}

/** Canonicalize Windows Path/PATH before spawning a child process. */
export function withExecutablePath(env: Environment, prefix: string, platform: NodeJS.Platform = process.platform): Record<string, string | undefined> {
  const result = { ...env };
  const keys = Object.keys(result).filter(key => platform === "win32" ? key.toLowerCase() === "path" : key === "PATH");
  const inherited = result.PATH ?? keys.map(key => result[key]).find(Boolean);
  for (const key of keys) delete result[key];
  const separator = platform === "win32" ? ";" : ":";
  result.PATH = [...new Set([prefix, inherited].filter(Boolean).flatMap(value => value!.split(separator)))].join(separator);
  return result;
}

export const envText = (env: Environment, name: string, fallback = ""): string =>
  String(env[name] ?? fallback).trim();

export function envFlag(env: Environment, name: string, fallback: boolean): boolean {
  const value = envText(env, name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

export function envInteger(
  env: Environment,
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = envText(env, name);
  const parsed = /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  if (bounds.min !== undefined && parsed < bounds.min) return fallback;
  if (bounds.max !== undefined && parsed > bounds.max) return fallback;
  return parsed;
}
