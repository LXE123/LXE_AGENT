import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging } from "../packages/foundation/core/src/index";
import { resolveDataServerRuntimeEnvironment } from "../apps/desktop/src/main/data-server-policy";
import { MaintenanceScheduler } from "../packages/agent/runtime/src/operations/maintenance";
import { SqliteRuntimeStore } from "../packages/agent/runtime/src/state/storage";

const serveOnAvailablePort = (fetch: (request: Request) => Promise<Response>) => {
  const firstPort = 49_152 + (process.pid % 10_000);
  for (let offset = 0; offset < 100; offset += 1) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port: firstPort + offset, fetch });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No available local port for Preview Data Server smoke test");
};

test("Preview settings environment uploads to the configured Data Server without logging its API key", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-preview-data-server-smoke-"));
  const dataRoot = join(root, "var");
  const apiKey = "preview-only-secret";
  const managedSecret = "managed-secret-must-not-win";
  const uploads: Array<{ authorization: string; body: string }> = [];
  const server = serveOnAvailablePort(async (request) => {
    const body = await request.text();
    uploads.push({
      authorization: request.headers.get("authorization") ?? "",
      body,
    });
    const turns = (JSON.parse(body) as { turns: Array<{ sequence: number }> }).turns;
    return Response.json({
      accepted_count: turns.length,
      accepted_through_sequence: turns.at(-1)?.sequence ?? 0,
    });
  });
  const sourceEnvironment = {
    LXE_DATA_SERVER_ENABLED: "1",
    LXE_DATA_SERVER_URL: `http://127.0.0.1:${server.port}`,
    LXE_DATA_SERVER_API_KEY: apiKey,
  };
  const environment = {
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
  await store.recordTurn("preview-session", {
    turn_id: "preview-turn",
    started_at: Date.now() / 1_000,
    platform: "preview-smoke",
    provider: "custom",
    model: "preview-model",
    status: "completed",
    elapsed_ms: 12,
    api_calls: 1,
    tool_calls: 0,
    input_tokens: 2,
    output_tokens: 3,
    tools: [],
    activations: [],
    executions: [],
  });
  const intervals: unknown[] = [];
  const initialTasks: Array<() => void> = [];
  const scheduler = new MaintenanceScheduler({
    environment,
    authEnabled: false,
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
      setTimeout: (callback, _delayMs) => {
        initialTasks.push(callback);
        return callback;
      },
      clearTimeout: (callback) => {
        const index = initialTasks.indexOf(callback as () => void);
        if (index >= 0) initialTasks.splice(index, 1);
      },
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
    expect(uploads).toHaveLength(0);
    initialTasks.shift()?.();
    for (let attempt = 0; attempt < 100 && uploads.length === 0; attempt += 1) await Bun.sleep(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(uploads[0]?.body ?? "{}")).toMatchObject({
      protocol_version: 1,
      gateway_id: "preview-gateway",
      turns: [{ turn_id: "preview-turn", platform: "preview-smoke" }],
    });
    expect(uploads[0]?.body).not.toContain("preview-session");
    expect(uploads[0]?.body).not.toContain("preview upload");
    let log = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      log = readFileSync(logging.filePath!, "utf8");
      if (log.includes('"message":"data_sync_uploaded"')) break;
      await Bun.sleep(1);
    }
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
