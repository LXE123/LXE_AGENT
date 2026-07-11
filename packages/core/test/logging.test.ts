import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logging from "../src/logging";

interface LoggingController {
  readonly filePath?: string;
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
    logger.error("startup failed", { error: new Error("boom"), secret: undefined });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(expect.objectContaining({
      timestamp: "2026-07-11T00:00:00.000Z",
      level: "error",
      logger: "gateway",
      message: "startup failed",
      boot_id: "boot-1",
      error: expect.objectContaining({ name: "Error", message: "boom" }),
    }));
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
  });
});
