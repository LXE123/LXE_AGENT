import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { JsonObject } from "@lxe/protocol";

export const text = (value: unknown): string => String(value ?? "").trim();

export const parseObject = (value: unknown): JsonObject => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  try {
    const parsed: unknown = JSON.parse(String(value ?? "{}"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    return {};
  }
};

export const clippedText = (value: unknown, maximum: number): string => text(value).slice(0, maximum);

export const allPrepared = <T>(
  database: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): T[] => {
  const statement = database.prepare<T, SQLQueryBindings[]>(sql);
  try {
    return statement.all(...bindings);
  } finally {
    statement.finalize();
  }
};

export const getPrepared = <T>(
  database: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): T | null => {
  const statement = database.prepare<T, SQLQueryBindings[]>(sql);
  try {
    return statement.get(...bindings);
  } finally {
    statement.finalize();
  }
};
