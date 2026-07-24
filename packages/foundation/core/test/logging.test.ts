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
      api_subcode: 11310,
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
      api_subcode: 11310,
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
      transport_error: "authorization: Bearer transport-private token=another-private",
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
    expect(lines[0]).not.toContain("transport-private");
    expect(lines[0]).not.toContain("another-private");
  });

  test("supports a wider explicit sanitizer policy without changing logger defaults", () => {
    const values = Array.from({ length: 150 }, (_, index) => ({ index }));
    const defaults = logging.sanitizeLogValue(values) as unknown[];
    const widened = logging.sanitizeLogValueWithPolicy(values, {
      maxDepth: 16,
      maxItems: 1_000,
      maxString: 8_192,
    }) as unknown[];
    expect(defaults).toHaveLength(101);
    expect(defaults.at(-1)).toBe("[50 items omitted]");
    expect(widened).toHaveLength(150);
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
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "DEBUG",
        LOCAL_LOG_RETENTION_DAYS: "7",
      },
    });
    controllers.push(controller);

    logger.debug("stream contract", { session_id: "session-1" });

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

  test("accepts a canonical state root without adding a second var segment", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "lxe-logging-state-root-"));
    roots.push(projectRoot);
    const stateRoot = join(projectRoot, "var");
    const controller = logging.configureLogging({
      projectRoot,
      stateRoot,
      fileName: "desktop.log",
      environment: { LOCAL_LOGS_ENABLED: "1" },
    });
    controllers.push(controller);
    logging.createLogger("desktop").info("state_root_contract");

    expect(controller.filePath!.startsWith(join(stateRoot, "logs", "runtime"))).toBeTrue();
    expect(controller.filePath).not.toContain(join("var", "var"));
    expect(readFileSync(controller.filePath!, "utf8")).toContain("state_root_contract");
  });

  test("honors logger overrides, disabled files, and retention", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-logging-policy-"));
    roots.push(root);
    const expired = join(root, "var", "logs", "runtime", "20000101");
    const unrelated = join(root, "var", "logs", "runtime", "manual");
    const legacyAgentTraceRoot = join(root, "var", "logs", "agent_traces");
    const expiredLegacyAgentTrace = join(legacyAgentTraceRoot, "20000101");
    const ignoredOverride = join(root, "custom-agent-traces", "20000101");
    mkdirSync(expired, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    mkdirSync(expiredLegacyAgentTrace, { recursive: true });
    mkdirSync(ignoredOverride, { recursive: true });
    writeFileSync(join(expired, "runtime.log"), "expired", "utf8");

    const controller = logging.configureLogging({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "DEBUG",
        LOG_LEVELS: "runtime=WARN",
        LOCAL_LOG_RETENTION_DAYS: "7",
        AGENT_STREAM_TRACE_DIR: join(root, "custom-agent-traces"),
      },
    });
    controllers.push(controller);
    const logger = logging.createLogger("runtime.child");
    logger.info("filtered");
    logger.warn("kept");

    const content = readFileSync(controller.filePath!, "utf8");
    expect(content).not.toContain("filtered");
    expect(content).toContain("kept");
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(legacyAgentTraceRoot)).toBe(false);
    expect(existsSync(ignoredOverride)).toBe(true);

    await controller.close();
    const disabled = logging.configureLogging({
      projectRoot: root,
      environment: { LOCAL_LOGS_ENABLED: "0" },
    });
    controllers.push(disabled);
    expect(disabled.filePath).toBeUndefined();
    expect(disabled.status).toEqual(expect.objectContaining({
      localFileEnabled: false,
      disabledReason: "disabled_by_config",
    }));

    await disabled.close();
    const fixedFile = logging.configureLogging({
      projectRoot: root,
      environment: { LOCAL_LOGS_ENABLED: "1", LOG_FILE: "custom.log" },
    });
    controllers.push(fixedFile);
    expect(fixedFile.filePath).toMatch(/logs[\\/]runtime[\\/]\d{8}[\\/]runtime\.log$/);
  });

  test("renders a human-readable console line with compact context and error trailer", () => {
    const line = logging.formatConsoleLine({
      timestamp: "2026-07-12T04:05:06.000Z",
      level: "error",
      logger: "gateway.feishu.cardkit",
      message: "card send failed",
      session_id: "session-1234567890",
      turn_id: "turn-abcdef",
      card_id: "card-42",
      error: { name: "FeishuCardKitError", message: "cardid is invalid", stack: "FeishuCardKitError: cardid is invalid\n    at send (cardkit.ts:1)\n    at run (runtime.ts:2)" },
    }, false);
    const [head, ...trailers] = line.split("\n");
    expect(head).toContain("ERROR");
    expect(head).toContain("gateway.feishu.cardkit");
    expect(head).toContain("card send failed");
    expect(head).toContain("s=session-");
    expect(head).toContain("t=turn-abc");
    expect(head).toContain("card_id=card-42");
    expect(head).toContain("error=FeishuCardKitError: cardid is invalid");
    expect(head).toMatch(/^\d{2}:\d{2}:\d{2}\s\s/);
    expect(head).not.toContain("{");
    expect(head).not.toContain("[");
    expect(trailers.length).toBeGreaterThan(0);
    expect(trailers[0]).toContain("at send (cardkit.ts:1)");
  });

  test("keeps info console lines single-line and flattens multi-line values", () => {
    const line = logging.formatConsoleLine({
      timestamp: "2026-07-12T04:05:06.000Z",
      level: "info",
      logger: "runtime.turn",
      message: "turn completed",
      reply: "first\nsecond",
      long: "x".repeat(500),
    }, false);
    expect(line).not.toContain("\n");
    expect(line).toContain("reply=first ⏎ second");
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(400);
  });

  test("pretty console output replaces JSON while the file sink stays JSONL", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-logging-pretty-"));
    roots.push(root);
    const environment = {
      LOCAL_LOGS_ENABLED: "1",
      LOG_CONSOLE_FORMAT: "json",
      LOG_LEVEL: "INFO",
      RUNTIME_LOG_LEVEL: "DEBUG",
    };
    const printed: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((line: string) => { printed.push(String(line)); });
    try {
      const controller = logging.configureLogging({ projectRoot: root, environment });
      controllers.push(controller);
      logging.createLogger("gateway.pretty").info("pretty line", { session_id: "session-42" });
      expect(printed.length).toBeGreaterThan(0);
      const consoleLine = printed.at(-1)!;
      expect(() => JSON.parse(consoleLine)).toThrow();
      expect(consoleLine).toContain("INFO");
      expect(consoleLine).toContain("pretty line");
      expect(consoleLine).toContain("s=session-");
      const fileLine = readFileSync(controller.filePath!, "utf8").trim().split(/\r?\n/).at(-1)!;
      expect(JSON.parse(fileLine)).toEqual(expect.objectContaining({
        logger: "gateway.pretty",
        message: "pretty line",
        session_id: "session-42",
      }));

    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("disables a failed file sink once and exposes the effective status", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-logging-failure-"));
    roots.push(root);
    const statuses: logging.LoggingStatus[] = [];
    const controller = logging.configureLogging({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "DEBUG",
      },
      onStatusChange: (status) => {
        statuses.push(status);
        throw new Error("listener broke");
      },
    });
    controllers.push(controller);
    const directory = join(root, "var", "logs", "runtime", controller.filePath!.split(/[\\/]/u).at(-2)!);
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "blocks directory recreation", "utf8");
    const fallback = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const logger = logging.createLogger("runtime");
      expect(() => logger.warn("first_write")).not.toThrow();
      expect(() => logger.warn("second_write")).not.toThrow();
      expect(fallback.mock.calls.filter((call) => String(call[0]).includes("logging_sink_failed"))).toHaveLength(1);
      expect(fallback.mock.calls.filter((call) => String(call[0]).includes("logging_status_listener_failed"))).toHaveLength(1);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toEqual(expect.objectContaining({
        localFileEnabled: false,
        disabledReason: "sink_failed",
        lastError: expect.any(String),
      }));
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
