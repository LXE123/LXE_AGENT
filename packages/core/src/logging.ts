import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { envFlag, envInteger, envText, type Environment } from "./env";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

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
  readonly disabledReason?: "disabled_by_config" | "missing_log_file";
  readonly consoleLevel: LogLevel;
  readonly fileLevel: LogLevel;
}

export interface ConfigureLoggingOptions {
  projectRoot: string;
  environment: Environment;
}

interface ProcessLoggingSink {
  write(level: LogLevel, logger: string, line: string): void;
  close(): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let processSink: ProcessLoggingSink | undefined;

const SAFE_ERROR_FIELDS = new Set([
  "method",
  "path",
  "http_status",
  "api_code",
  "log_id",
  "operation",
  "card_id",
]);

const errorValue = (error: Error, seen = new Set<Error>()): Record<string, unknown> => {
  if (seen.has(error)) return { name: error.name, message: error.message, cause: "[recursive]" };
  seen.add(error);
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack ?? "",
  };
  for (const [key, value] of Object.entries(error)) {
    if (SAFE_ERROR_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value)) {
      result[key] = value;
    }
  }
  if (error.cause instanceof Error) result.cause = errorValue(error.cause, seen);
  return result;
};

const jsonValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return errorValue(value);
  }
  return value;
};

const parseLevel = (value: string, fallback: LogLevel): LogLevel => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
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

const overrideLevel = (
  logger: string,
  levels: Array<{ prefix: string; level: LogLevel }>,
): LogLevel | undefined => levels
  .filter((item) => logger === item.prefix || logger.startsWith(`${item.prefix}.`))
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

const cleanupRetention = (projectRoot: string, environment: Environment, today = new Date()): void => {
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
    for (const name of readdirSync(root)) {
      const entry = resolve(root, name);
      const date = dateValue(name);
      if (date === undefined || date >= cutoff) continue;
      try {
        if (statSync(entry).isDirectory()) rmSync(entry, { recursive: true, force: true });
      } catch {
        // Retention failure must never prevent Gateway startup.
      }
    }
  }
  const rawEventRoot = resolveConfiguredPath(
    envText(environment, "FEISHU_RAW_EVENT_DUMP_DIR"),
    "logs/feishu_raw_events",
    projectRoot,
  );
  if (!existsSync(rawEventRoot)) return;
  for (const name of readdirSync(rawEventRoot)) {
    const match = /^(\d{8})\.jsonl$/.exec(name);
    const date = match ? dateValue(match[1]!) : undefined;
    if (date === undefined || date >= cutoff) continue;
    try {
      rmSync(resolve(rawEventRoot, name), { force: true });
    } catch {
      // Retention failure must never prevent Gateway startup.
    }
  }
};

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
  if (filePath) {
    cleanupRetention(projectRoot, environment);
    mkdirSync(dirname(filePath), { recursive: true });
  }
  let closed = false;
  const sink: ProcessLoggingSink = {
    write(level, logger, line) {
      if (closed) return;
      const override = overrideLevel(logger, overrides);
      if (shouldWrite(level, consoleLevel, override)) console.log(line);
      if (filePath && shouldWrite(level, fileLevel, override)) {
        try {
          appendFileSync(filePath, `${line}\n`, "utf8");
        } catch (error) {
          console.error(`failed to append runtime log: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    close() {
      closed = true;
      if (processSink === sink) processSink = undefined;
    },
  };
  processSink = sink;
  const status: LoggingStatus = {
    localFileEnabled: Boolean(filePath),
    ...(filePath ? { filePath } : {}),
    ...(!filePath ? { disabledReason: enabled ? "missing_log_file" as const : "disabled_by_config" as const } : {}),
    consoleLevel,
    fileLevel,
  };
  return {
    ...(filePath ? { filePath } : {}),
    status,
    flush: async () => undefined,
    close: async () => sink.close(),
  };
}

export function createLogger(
  name: string,
  options: LoggerOptions = {},
  context: LogFields = {},
): Logger {
  const now = options.now ?? (() => new Date().toISOString());
  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    const record: Record<string, unknown> = {
      timestamp: now(),
      level,
      logger: name,
      message,
    };
    for (const [key, value] of Object.entries({ ...context, ...fields })) {
      if (value !== undefined) record[key] = jsonValue(value);
    }
    const line = JSON.stringify(record);
    if (options.write) options.write(line);
    else if (processSink) processSink.write(level, name, line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(name, options, { ...context, ...fields }),
  };
}
