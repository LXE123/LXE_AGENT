export type Environment = Readonly<Record<string, string | undefined>>;

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
