import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { envFlag, envInteger, envText, type Environment } from "./env";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface LogContext {
  session_id?: string;
  turn_id?: string;
  response_route_id?: string;
  message_id?: string;
  task_id?: string;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => string;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggingController {
  readonly filePath?: string;
  readonly status: LoggingStatus;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LoggingStatus {
  readonly localFileEnabled: boolean;
  readonly filePath?: string;
  readonly disabledReason?: "disabled_by_config" | "missing_log_file" | "sink_failed";
  readonly lastError?: string;
  readonly consoleLevel: LogLevel;
  readonly fileLevel: LogLevel;
}

export interface LogSanitizePolicy {
  maxDepth?: number;
  maxItems?: number;
  maxString?: number;
  maxStackString?: number;
}

export interface ConfigureLoggingOptions {
  projectRoot: string;
  environment: Environment;
}

interface ProcessLoggingSink {
  write(level: LogLevel, logger: string, line: string): void;
  close(): void;
}

interface MutableLoggingStatus {
  localFileEnabled: boolean;
  filePath?: string;
  disabledReason?: LoggingStatus["disabledReason"];
  lastError?: string;
  consoleLevel: LogLevel;
  fileLevel: LogLevel;
}

interface RetentionResult {
  deleted: string[];
  failures: Array<{ path: string; error: string }>;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_CONTEXT = new AsyncLocalStorage<Readonly<LogContext>>();
const MAX_LOG_DEPTH = 8;
const MAX_LOG_ITEMS = 100;
const MAX_LOG_STRING = 8_000;
const DEFAULT_SANITIZE_POLICY: Required<LogSanitizePolicy> = {
  maxDepth: MAX_LOG_DEPTH,
  maxItems: MAX_LOG_ITEMS,
  maxString: MAX_LOG_STRING,
  maxStackString: 16_000,
};
const SAFE_ERROR_FIELDS = new Set([
  "method", "path", "http_status", "api_code", "log_id", "operation", "card_id",
]);
const SENSITIVE_KEYS = new Set([
  "authorization", "proxyauthorization", "cookie", "setcookie", "token", "accesstoken",
  "refreshtoken", "sessiontoken", "apikey", "xapikey", "secret", "appsecret", "clientsecret",
  "password", "signature", "redactedthinking",
]);

let processSink: ProcessLoggingSink | undefined;

const safeConsole = (method: "log" | "error", line: string): void => {
  try {
    console[method](line);
  } catch {
    // Logging must never affect business execution.
  }
};

const normalizedKey = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
const truncate = (value: string, limit = MAX_LOG_STRING): string => {
  if (value.length <= limit) return value;
  const omitted = value.length - limit;
  const marker = `...[${omitted} chars omitted]...`;
  const available = Math.max(2, limit - marker.length);
  const head = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
};
const redactSensitiveText = (value: string): string => value
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
  .replace(
    /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|cookie|password|signature)\b(\s*[:=]\s*)([^\s,;]+)/gi,
    "$1$2[redacted]",
  );

const sanitizePolicy = (policy: LogSanitizePolicy = {}): Required<LogSanitizePolicy> => ({
  maxDepth: Math.max(1, Math.trunc(policy.maxDepth ?? DEFAULT_SANITIZE_POLICY.maxDepth)),
  maxItems: Math.max(1, Math.trunc(policy.maxItems ?? DEFAULT_SANITIZE_POLICY.maxItems)),
  maxString: Math.max(64, Math.trunc(policy.maxString ?? DEFAULT_SANITIZE_POLICY.maxString)),
  maxStackString: Math.max(64, Math.trunc(policy.maxStackString ?? DEFAULT_SANITIZE_POLICY.maxStackString)),
});

const errorValue = (
  error: Error,
  depth: number,
  seen: WeakSet<object>,
  policy: Required<LogSanitizePolicy>,
): Record<string, unknown> => {
  if (seen.has(error)) return { name: error.name, message: truncate(error.message, policy.maxString), cause: "[recursive]" };
  seen.add(error);
  const result: Record<string, unknown> = {
    name: truncate(error.name, policy.maxString),
    message: truncate(redactSensitiveText(error.message), policy.maxString),
    stack: truncate(redactSensitiveText(error.stack ?? ""), policy.maxStackString),
  };
  try {
    for (const [key, value] of Object.entries(error)) {
      if (SAFE_ERROR_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value)) {
        result[key] = typeof value === "string" ? truncate(redactSensitiveText(value), policy.maxString) : value;
      }
    }
  } catch {
    // Error extensions are optional diagnostics.
  }
  if (depth < policy.maxDepth && error.cause instanceof Error) {
    result.cause = errorValue(error.cause, depth + 1, seen, policy);
  }
  return result;
};

const sanitizeValue = (
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
  policy: Required<LogSanitizePolicy>,
): unknown => {
  if (key && SENSITIVE_KEYS.has(normalizedKey(key))) return "***";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncate(redactSensitiveText(value), policy.maxString);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (depth >= policy.maxDepth) return "[max depth]";
  if (value instanceof Error) return errorValue(value, depth, seen, policy);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof URL) return truncate(value.toString(), policy.maxString);
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} omitted: ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) return `[ArrayBuffer omitted: ${value.byteLength} bytes]`;
  if (typeof value !== "object") return truncate(String(value));
  if (seen.has(value)) return "[recursive]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, policy.maxItems).map((item) => sanitizeValue(item, "", depth + 1, seen, policy));
      if (value.length > policy.maxItems) items.push(`[${value.length - policy.maxItems} items omitted]`);
      return items;
    }
    if (value instanceof Map) {
      return sanitizeValue(Object.fromEntries([...value.entries()].slice(0, policy.maxItems)), key, depth + 1, seen, policy);
    }
    if (value instanceof Set) return sanitizeValue([...value].slice(0, policy.maxItems), key, depth + 1, seen, policy);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of entries.slice(0, policy.maxItems)) {
      result[childKey] = sanitizeValue(childValue, childKey, depth + 1, seen, policy);
    }
    if (entries.length > policy.maxItems) result._omitted_fields = entries.length - policy.maxItems;
    return result;
  } catch (error) {
    return `[unserializable: ${truncate(error instanceof Error ? error.message : String(error), 500)}]`;
  } finally {
    seen.delete(value);
  }
};

export function sanitizeLogValue(
  value: unknown,
  key = "",
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  return sanitizeValue(value, key, depth, seen, DEFAULT_SANITIZE_POLICY);
}

export function sanitizeLogValueWithPolicy(
  value: unknown,
  policy: LogSanitizePolicy,
  key = "",
): unknown {
  return sanitizeValue(value, key, 0, new WeakSet<object>(), sanitizePolicy(policy));
}

const cleanedContext = (value: LogContext): LogContext => Object.fromEntries(
  Object.entries(value).flatMap(([key, item]) => {
    const text = String(item ?? "").trim();
    return text ? [[key, text]] : [];
  }),
) as LogContext;

export function currentLogContext(): Readonly<LogContext> {
  return { ...(LOG_CONTEXT.getStore() ?? {}) };
}

export function runWithLogContext<T>(context: LogContext, operation: () => T): T {
  return LOG_CONTEXT.run({ ...(LOG_CONTEXT.getStore() ?? {}), ...cleanedContext(context) }, operation);
}

const parseLevel = (value: string, fallback: LogLevel): LogLevel => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") return normalized;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    if (numeric >= 40) return "error";
    if (numeric >= 30) return "warn";
    if (numeric >= 20) return "info";
    return "debug";
  }
  return fallback;
};

const loggerLevels = (raw: string): Array<{ prefix: string; level: LogLevel }> =>
  String(raw ?? "").split(",").flatMap((item) => {
    const separator = item.indexOf("=");
    if (separator <= 0) return [];
    const prefix = item.slice(0, separator).trim();
    const level = item.slice(separator + 1).trim();
    return prefix ? [{ prefix, level: parseLevel(level, "debug") }] : [];
  });

const overrideLevel = (logger: string, levels: Array<{ prefix: string; level: LogLevel }>): LogLevel | undefined =>
  levels.filter((item) => logger === item.prefix || logger.startsWith(`${item.prefix}.`))
    .sort((left, right) => right.prefix.length - left.prefix.length)[0]?.level;

const shouldWrite = (level: LogLevel, threshold: LogLevel, override?: LogLevel): boolean =>
  LEVEL_RANK[level] >= Math.max(LEVEL_RANK[threshold], override ? LEVEL_RANK[override] : 0);

const localDay = (date = new Date()): string =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

const resolveConfiguredPath = (raw: string, fallback: string, projectRoot: string): string => {
  const configured = String(raw || fallback).trim() || fallback;
  return resolve(isAbsolute(configured) ? configured : join(projectRoot, configured));
};

const dateValue = (name: string): number | undefined => {
  if (!/^\d{8}$/.test(name)) return undefined;
  const year = Number(name.slice(0, 4));
  const month = Number(name.slice(4, 6));
  const day = Number(name.slice(6, 8));
  const value = new Date(year, month - 1, day);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) return undefined;
  return value.getTime();
};

const failureText = (error: unknown): string => truncate(error instanceof Error ? error.message : String(error), 1_000);

const cleanupRetention = (projectRoot: string, environment: Environment, today = new Date()): RetentionResult => {
  const result: RetentionResult = { deleted: [], failures: [] };
  const retentionDays = envInteger(environment, "LOCAL_LOG_RETENTION_DAYS", 7, { min: 1 });
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (retentionDays - 1)).getTime();
  const directoryRoots = [
    resolveConfiguredPath(envText(environment, "AGENT_STREAM_TRACE_DIR"), "logs/agent_traces", projectRoot),
    resolveConfiguredPath(envText(environment, "AGENT_SSE_WIRE_TRACE_DIR"), "logs/sse_wire_traces", projectRoot),
    resolve(projectRoot, "logs", "feishu_msg"),
    resolve(projectRoot, "logs", "runtime"),
  ];
  for (const root of directoryRoots) {
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (error) {
      result.failures.push({ path: root, error: failureText(error) });
      continue;
    }
    for (const name of names) {
      const entry = resolve(root, name);
      const date = dateValue(name);
      if (date === undefined || date >= cutoff) continue;
      try {
        if (statSync(entry).isDirectory()) {
          rmSync(entry, { recursive: true, force: true });
          result.deleted.push(entry);
        }
      } catch (error) {
        result.failures.push({ path: entry, error: failureText(error) });
      }
    }
  }
  const rawEventRoot = resolveConfiguredPath(envText(environment, "FEISHU_RAW_EVENT_DUMP_DIR"), "logs/feishu_raw_events", projectRoot);
  if (!existsSync(rawEventRoot)) return result;
  let names: string[];
  try {
    names = readdirSync(rawEventRoot);
  } catch (error) {
    result.failures.push({ path: rawEventRoot, error: failureText(error) });
    return result;
  }
  for (const name of names) {
    const match = /^(\d{8})\.jsonl$/.exec(name);
    const date = match ? dateValue(match[1]!) : undefined;
    if (date === undefined || date >= cutoff) continue;
    const entry = resolve(rawEventRoot, name);
    try {
      rmSync(entry, { force: true });
      result.deleted.push(entry);
    } catch (error) {
      result.failures.push({ path: entry, error: failureText(error) });
    }
  }
  return result;
};

const statusSnapshot = (status: MutableLoggingStatus): LoggingStatus => ({
  localFileEnabled: status.localFileEnabled,
  ...(status.filePath ? { filePath: status.filePath } : {}),
  ...(status.disabledReason ? { disabledReason: status.disabledReason } : {}),
  ...(status.lastError ? { lastError: status.lastError } : {}),
  consoleLevel: status.consoleLevel,
  fileLevel: status.fileLevel,
});

export function configureLogging(options: ConfigureLoggingOptions): LoggingController {
  processSink?.close();
  const projectRoot = resolve(options.projectRoot);
  const environment = options.environment;
  const consoleLevel = parseLevel(envText(environment, "LOG_LEVEL", "INFO"), "info");
  const fileLevel = parseLevel(envText(environment, "RUNTIME_LOG_LEVEL", "DEBUG"), "debug");
  const overrides = loggerLevels(envText(environment, "LOG_LEVELS"));
  const enabled = envFlag(environment, "LOCAL_LOGS_ENABLED", false);
  const fileName = basename(envText(environment, "LOG_FILE"));
  const filePath = enabled && fileName && ![".", ".."].includes(fileName)
    ? resolve(projectRoot, "logs", "runtime", localDay(), fileName)
    : undefined;
  const retention = enabled ? cleanupRetention(projectRoot, environment) : { deleted: [], failures: [] };
  if (filePath) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
    } catch (error) {
      retention.failures.push({ path: dirname(filePath), error: failureText(error) });
    }
  }
  const status: MutableLoggingStatus = {
    localFileEnabled: Boolean(filePath),
    ...(filePath ? { filePath } : {}),
    ...(!filePath ? { disabledReason: enabled ? "missing_log_file" as const : "disabled_by_config" as const } : {}),
    consoleLevel,
    fileLevel,
  };
  let closed = false;
  let fileUsable = Boolean(filePath);
  let sinkFailureReported = false;
  const sink: ProcessLoggingSink = {
    write(level, logger, line) {
      if (closed) return;
      const override = overrideLevel(logger, overrides);
      if (shouldWrite(level, consoleLevel, override)) safeConsole("log", line);
      if (filePath && fileUsable && shouldWrite(level, fileLevel, override)) {
        try {
          appendFileSync(filePath, `${line}\n`, "utf8");
        } catch (error) {
          fileUsable = false;
          status.localFileEnabled = false;
          status.disabledReason = "sink_failed";
          status.lastError = failureText(error);
          if (!sinkFailureReported) {
            sinkFailureReported = true;
            safeConsole("error", JSON.stringify({
              timestamp: new Date().toISOString(), level: "error", logger: "logging",
              message: "logging_sink_failed", file_path: filePath, error: status.lastError,
            }));
          }
        }
      }
    },
    close() {
      closed = true;
      if (processSink === sink) processSink = undefined;
    },
  };
  processSink = sink;
  const retentionLogger = createLogger("logging.retention");
  if (retention.deleted.length > 0) retentionLogger.info("log_retention_completed", {
    deleted_count: retention.deleted.length,
    retention_days: envInteger(environment, "LOCAL_LOG_RETENTION_DAYS", 7, { min: 1 }),
  });
  for (const failure of retention.failures) retentionLogger.warn("log_retention_failed", failure);
  return {
    ...(filePath ? { filePath } : {}),
    get status() { return statusSnapshot(status); },
    flush: async () => undefined,
    close: async () => sink.close(),
  };
}

const logFallback = (logger: string, message: string, error: unknown): void => {
  safeConsole("error", JSON.stringify({
    timestamp: new Date().toISOString(), level: "error", logger: "logging",
    message: "logging_record_failed", source_logger: truncate(logger, 300),
    source_message: truncate(message, 1_000), error: failureText(error),
  }));
};

export function createLogger(name: string, options: LoggerOptions = {}, context: LogFields = {}): Logger {
  const now = options.now ?? (() => new Date().toISOString());
  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    try {
      const record: Record<string, unknown> = {
        timestamp: now(), level, logger: name, message: truncate(String(message ?? ""), 2_000),
      };
      const merged = { ...fields, ...context, ...currentLogContext() };
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) record[key] = sanitizeLogValue(value, key);
      }
      const line = JSON.stringify(record);
      if (options.write) {
        try { options.write(line); } catch (error) { logFallback(name, message, error); }
      } else if (processSink) processSink.write(level, name, line);
      else safeConsole("log", line);
    } catch (error) {
      logFallback(name, message, error);
    }
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(name, options, { ...context, ...fields }),
  };
}
