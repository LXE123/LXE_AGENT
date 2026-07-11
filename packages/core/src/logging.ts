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

const jsonValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? "" };
  }
  return value;
};

export function createLogger(
  name: string,
  options: LoggerOptions = {},
  context: LogFields = {},
): Logger {
  const write = options.write ?? ((line: string) => console.log(line));
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
    write(JSON.stringify(record));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(name, { write, now }, { ...context, ...fields }),
  };
}
