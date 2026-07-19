import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../packages/foundation/core/src/index";
import { resolveDataServerRuntimeEnvironment } from "../apps/desktop/src/main/data-server-policy";
import { loadProjectEnv } from "../apps/gateway/src/bootstrap/env";
import { MaintenanceScheduler } from "../packages/agent/runtime/src/operations/maintenance";
import { SqliteRuntimeStore } from "../packages/agent/runtime/src/state/storage";

test("Preview repository env uploads to the configured Data Server without logging its API key", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-preview-data-server-smoke-"));
  const dataRoot = join(root, "var");
  const apiKey = "preview-only-secret";
  const managedSecret = "managed-secret-must-not-win";
  const uploads: Array<{ authorization: string; body: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      uploads.push({
        authorization: request.headers.get("authorization") ?? "",
        body: await request.text(),
      });
      return Response.json({ sessions_received: 1, messages_received: 1 });
    },
  });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, ".env"), `LXE_DATA_SERVER_API_KEY=${apiKey}\n`, "utf8");
  writeFileSync(join(root, ".env.local"), [
    "LXE_DATA_SERVER_ENABLED=1",
    `LXE_DATA_SERVER_URL=http://127.0.0.1:${server.port}`,
  ].join("\n"), "utf8");
  writeFileSync(join(root, "config", "runtime.env"), [
    "LXE_DATA_SERVER_ENABLED=0",
    "LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS=3600",
    "LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS=30",
    "LXE_DATA_SERVER_SESSION_LIMIT=1000",
  ].join("\n"), "utf8");

  const sourceEnvironment = loadProjectEnv({ projectRoot: root, initial: {} });
  const environment = {
    LXE_MAINTENANCE_AUTH_ENABLED: "0",
    ...resolveDataServerRuntimeEnvironment({
      packaged: false,
      sourceEnvironment,
      managedEnvironment: {
        LXE_DATA_SERVER_ENABLED: "0",
        LXE_DATA_SERVER_URL: "",
        LXE_DATA_SERVER_API_KEY: managedSecret,
      },
      machineIdentityPath: join(dataRoot, "db", "machine_identity.json"),
    }),
  };
  const logging = configureLogging({
    projectRoot: root,
    stateRoot: dataRoot,
    environment: {
      LOCAL_LOGS_ENABLED: "1",
      LOG_FILE: "runtime.log",
      LOG_LEVEL: "ERROR",
      RUNTIME_LOG_LEVEL: "INFO",
    },
  });
  const store = new SqliteRuntimeStore(join(dataRoot, "db", "agent.sqlite3"));
  await store.start();
  await store.ensureSession({
    session_id: "preview-session",
    source: { platform: "preview-smoke" },
    workspace: { directory: root, worktree: root },
  });
  await store.appendMessage("preview-session", { role: "user", content: "preview upload" });
  const intervals: unknown[] = [];
  const scheduler = new MaintenanceScheduler({
    environment,
    store,
    gatewayId: "preview-gateway",
    authRunner: {
      execute: async () => ({
        protocol_version: "1",
        type: "result",
        command: "auth refresh",
        ok: true,
        data: {},
        files: [],
      }),
    },
    clock: {
      setInterval: (_callback, _delayMs) => {
        const interval = Symbol("interval");
        intervals.push(interval);
        return interval;
      },
      clearInterval: (interval) => {
        const index = intervals.indexOf(interval);
        if (index >= 0) intervals.splice(index, 1);
      },
    },
  });

  try {
    await scheduler.start();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(uploads[0]?.body ?? "{}")).toMatchObject({
      gateway_id: "preview-gateway",
      sessions: [{ session_id: "preview-session" }],
    });
    await logging.flush();
    const log = readFileSync(logging.filePath!, "utf8");
    expect(log).toContain('"message":"maintenance_configured"');
    expect(log).toContain('"data_sync_enabled":true');
    expect(log).toContain('"message":"data_sync_uploaded"');
    expect(log).toContain('"target":"cloud"');
    expect(log).not.toContain(apiKey);
    expect(log).not.toContain(managedSecret);
  } finally {
    await scheduler.stop();
    await store.stop();
    await logging.close();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
