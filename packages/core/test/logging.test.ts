import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logging from "../src/logging";

interface LoggingController {
  readonly filePath?: string;
  readonly status: {
    localFileEnabled: boolean;
    filePath?: string;
    disabledReason?: string;
    consoleLevel: string;
    fileLevel: string;
  };
  flush(): Promise<void>;
  close(): Promise<void>;
}

const roots: string[] = [];
const controllers: LoggingController[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("structured logger", () => {
  test("emits one JSON record with stable context and a serialized error", () => {
    const lines: string[] = [];
    const logger = logging.createLogger("gateway", {
      write: (line) => lines.push(line),
      now: () => "2026-07-11T00:00:00.000Z",
    }).child({ boot_id: "boot-1" });
    const cause = Object.assign(new Error("boom"), {
      method: "POST",
      path: "/open-apis/cardkit/v1/cards",
      http_status: 400,
      api_code: 230099,
      log_id: "log-1",
      operation: "create_stream_card",
      authorization: "Bearer private",
    });
    logger.error("startup failed", { error: cause, secret: undefined });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(expect.objectContaining({
      timestamp: "2026-07-11T00:00:00.000Z",
      level: "error",
      logger: "gateway",
      message: "startup failed",
      boot_id: "boot-1",
      error: expect.objectContaining({ name: "Error", message: "boom" }),
    }));
    expect(JSON.parse(lines[0]!).error).toEqual(expect.objectContaining({
      method: "POST",
      http_status: 400,
      api_code: 230099,
      log_id: "log-1",
    }));
    expect(lines[0]).not.toContain("Bearer private");
  });

  test("isolates async log context and prevents call sites from replacing correlation ids", async () => {
    const lines: string[] = [];
    const logger = logging.createLogger("runtime.concurrent", {
      write: (line) => lines.push(line),
    }).child({ session_id: "child-session", component: "test" });

    await Promise.all([
      logging.runWithLogContext({ session_id: "session-a", turn_id: "turn-a" }, async () => {
        await Bun.sleep(0);
        logger.info("context_a", { session_id: "call-session", value: "a" });
      }),
      logging.runWithLogContext({ session_id: "session-b", turn_id: "turn-b" }, async () => {
        await Bun.sleep(0);
        logger.info("context_b", { value: "b" });
      }),
    ]);

    const records = lines.map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      message: "context_a", session_id: "session-a", turn_id: "turn-a", value: "a",
    }));
    expect(records).toContainEqual(expect.objectContaining({
      message: "context_b", session_id: "session-b", turn_id: "turn-b", value: "b",
    }));
    expect(logging.currentLogContext()).toEqual({});
  });

  test("sanitizes recursive, binary, bigint, oversized, and credential fields without throwing", () => {
    const lines: string[] = [];
    const logger = logging.createLogger("runtime.safe", { write: (line) => lines.push(line) });
    const recursive: Record<string, unknown> = { value: 1 };
    recursive.self = recursive;

    expect(() => logger.info("safe_record", {
      recursive,
      count: 123n,
      bytes: new Uint8Array([1, 2, 3]),
      long: "x".repeat(9_000),
      headers: { authorization: "Bearer private", cookie: "secret-cookie", accept: "json" },
    })).not.toThrow();

    const record = JSON.parse(lines[0]!);
    expect(record.recursive.self).toBe("[recursive]");
    expect(record.count).toBe("123");
    expect(record.bytes).toContain("3 bytes");
    expect(record.long.length).toBeLessThanOrEqual(8_000);
    expect(record.headers).toEqual({ authorization: "***", cookie: "***", accept: "json" });
    expect(lines[0]).not.toContain("Bearer private");
    expect(lines[0]).not.toContain("secret-cookie");
  });

  test("contains custom writer failures", () => {
    const fallback = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const logger = logging.createLogger("runtime.writer", { write: () => { throw new Error("writer broke"); } });
      expect(() => logger.warn("writer_failure")).not.toThrow();
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(String(fallback.mock.calls[0]?.[0])).toContain("logging_record_failed");
    } finally {
      fallback.mockRestore();
    }
  });

  test("configures a pre-created logger to append debug JSON to the dated runtime log", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-logging-"));
    roots.push(root);
    const logger = logging.createLogger("runtime");
    expect(typeof (logging as Record<string, unknown>).configureLogging).toBe("function");
    const configureLogging = (logging as unknown as {
      configureLogging(options: {
        projectRoot: string;
        environment: Readonly<Record<string, string | undefined>>;
      }): LoggingController;
    }).configureLogging;
    const controller = configureLogging({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_FILE: "runtime.log",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "DEBUG",
        LOCAL_LOG_RETENTION_DAYS: "7",
      },
    });
    controllers.push(controller);

    logger.debug("stream contract", { session_id: "session-1" });
    await controller.flush();

    expect(controller.filePath).toMatch(/logs[\\/]runtime[\\/]\d{8}[\\/]runtime\.log$/);
    expect(controller.status).toEqual(expect.objectContaining({
      localFileEnabled: true,
      filePath: controller.filePath,
      consoleLevel: "error",
      fileLevel: "debug",
    }));
    const records = readFileSync(controller.filePath!, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      level: "debug",
      logger: "runtime",
      message: "stream contract",
      session_id: "session-1",
    }));
  });

  test("honors logger overrides, disabled files, and retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-logging-policy-"));
    roots.push(root);
    const expired = join(root, "logs", "runtime", "20000101");
    const unrelated = join(root, "logs", "runtime", "manual");
    mkdirSync(expired, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(expired, "runtime.log"), "expired", "utf8");

    const controller = logging.configureLogging({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_FILE: "runtime.log",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "DEBUG",
        LOG_LEVELS: "runtime=WARN",
        LOCAL_LOG_RETENTION_DAYS: "7",
      },
    });
    controllers.push(controller);
    const logger = logging.createLogger("runtime.child");
    logger.info("filtered");
    logger.warn("kept");
    await controller.flush();

    const content = readFileSync(controller.filePath!, "utf8");
    expect(content).not.toContain("filtered");
    expect(content).toContain("kept");
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);

    await controller.close();
    const disabled = logging.configureLogging({
      projectRoot: root,
      environment: { LOCAL_LOGS_ENABLED: "0", LOG_FILE: "runtime.log" },
    });
    controllers.push(disabled);
    expect(disabled.filePath).toBeUndefined();
    expect(disabled.status).toEqual(expect.objectContaining({
      localFileEnabled: false,
      disabledReason: "disabled_by_config",
    }));

    await disabled.close();
    const missingFile = logging.configureLogging({
      projectRoot: root,
      environment: { LOCAL_LOGS_ENABLED: "1", LOG_FILE: "" },
    });
    controllers.push(missingFile);
    expect(missingFile.status).toEqual(expect.objectContaining({
      localFileEnabled: false,
      disabledReason: "missing_log_file",
    }));
  });

  test("disables a failed file sink once and exposes the effective status", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-logging-failure-"));
    roots.push(root);
    const controller = logging.configureLogging({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_FILE: "runtime.log",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "DEBUG",
      },
    });
    controllers.push(controller);
    const directory = join(root, "logs", "runtime", controller.filePath!.split(/[\\/]/u).at(-2)!);
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "blocks directory recreation", "utf8");
    const fallback = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const logger = logging.createLogger("runtime");
      expect(() => logger.warn("first_write")).not.toThrow();
      expect(() => logger.warn("second_write")).not.toThrow();
      expect(fallback.mock.calls.filter((call) => String(call[0]).includes("logging_sink_failed"))).toHaveLength(1);
      expect(controller.status).toEqual(expect.objectContaining({
        localFileEnabled: false,
        disabledReason: "sink_failed",
        lastError: expect.any(String),
      }));
    } finally {
      fallback.mockRestore();
    }
  });
});
