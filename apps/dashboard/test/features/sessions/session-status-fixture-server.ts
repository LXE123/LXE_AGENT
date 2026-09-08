// Test-only backend: production coordinator + real Runtime SQLite, no model calls.
// From the repository root: bun apps/dashboard/test/features/sessions/session-status-fixture-server.ts
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { createServer } from "vite";
import { SessionStatusStore } from "../../../../../packages/agent/runtime/src/state/session-status-store";
import { SessionStatusCoordinator } from "../../../../gateway/src/orchestration/session-status";
import type { SessionRunPhase, SessionRunUpdate } from "@lxe/protocol/session-status";
import type { AgentJob } from "@lxe/protocol";

const directory = mkdtempSync(join(tmpdir(), "lxe-status-window-"));
let db = new Database(join(directory, "agent.sqlite3"));
SessionStatusStore.migrate(db);
let store = new SessionStatusStore(db);
const listeners = new Set<ServerResponse>();
const live = new Map<string, Omit<SessionRunUpdate, "event_version">>();
const records = new Map<string, { turn: string; state: SessionRunPhase }>();
const createCoordinator = () => new SessionStatusCoordinator({
  request: async request => store.request(request), live: () => [...live.values()],
  publish: snapshot => { for (const listener of listeners) listener.write(`data: ${JSON.stringify(snapshot)}\n\n`); },
  onError: error => console.error(error),
});
let coordinator = createCoordinator();
coordinator.setReady(true);
const ids = ["running", "stopping", "queued", "success", "failure", "cancelled", "unknown", "idle"];
const session = (id: string) => ({ session_id: id, title: `${id} · 会话状态验收`, source: {}, source_summary: { platform: "desktop", chat_type: "dm" }, workspace: { directory: "/fixture", worktree: "/fixture" }, model: "fixture", reasoning_effort: "", model_config: {}, pinned_at: 0, created_at: 1, last_active_at: 1, message_count: 2, tool_call_count: 0, input_tokens: 0, output_tokens: 0, api_call_count: 0 });
async function transition(id: string, turn: string, state: SessionRunPhase, loaded = true) {
  const key = `${id}:${turn}`;
  if (["queued", "running", "stopping"].includes(state)) live.set(key, { session_id: id, turn_id: turn, state });
  else live.delete(key);
  if (loaded) records.set(id, { turn, state });
  coordinator.event({ state: state === "unknown" ? "running" : state, job: { session_id: id, job_id: turn } as AgentJob });
  await coordinator.flush();
}
for (const id of ids.filter(id => id !== "idle")) await transition(id, `initial-${id}`, (id === "success" ? "completed" : id === "failure" ? "error" : id) as SessionRunPhase);
// Simulate an abandoned task without affecting the genuinely live ones.
live.delete("unknown:initial-unknown");
coordinator.setReady(false); coordinator.setReady(true); await coordinator.flush();

const server = await createServer({ root: resolve("apps/dashboard"), server: { host: "127.0.0.1", port: 5199, strictPort: true }, plugins: [{ name: "session-status-fixture", configureServer(server) {
  server.middlewares.use("/__session_status_fixture", async (req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n"); listeners.add(res); res.on("close", () => listeners.delete(res)); return;
    }
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const { operation, input = {} } = JSON.parse(body);
      let result: unknown;
      if (operation === "sessions.status.list") result = await coordinator.list(input.session_ids);
      else if (operation === "sessions.status.ack") result = await coordinator.ack(input.session_id, input.turn_id, input.version);
      else if (operation === "fixture.sessions") result = ids.map(session);
      else if (operation === "fixture.transition") { await transition(input.id, input.turn, input.state, input.loaded !== false); result = true; }
      else if (operation === "fixture.restart") {
        await coordinator.stop(); db.close(); db = new Database(join(directory, "agent.sqlite3")); store = new SessionStatusStore(db);
        live.clear(); coordinator = createCoordinator(); coordinator.setReady(true); await coordinator.flush(); result = true;
      } else if (operation === "sessions.activity") result = { session_id: input.session_id, active: null, latest: null, queued: [] };
      else if (operation === "sessions.detail") {
        const record = records.get(input.session_id);
        const messages = record ? [{ display_group_id: record.turn, display_id: `${record.turn}:answer`, role: "assistant", content: `Fixture result: ${record.state}`, created_at: 1, turn: { turn_id: record.turn, status: record.state, elapsed_ms: 100 } }] : [];
        result = { session: session(input.session_id), messages, messages_page: { fetched_at: Date.now(), total: messages.length, raw_message_total: messages.length, limit: 10, group_cursors: messages.map(m => m.display_group_id), oldest_cursor: record?.turn ?? null, newest_cursor: record?.turn ?? null, previous_cursor: null, next_cursor: null, has_previous: false, has_next: false } };
        await new Promise(resolve => setTimeout(resolve, 150));
      } else throw new Error(`Unexpected fixture operation ${operation}`);
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
} }] });
await server.listen();
console.log("http://127.0.0.1:5199/test/features/sessions/session-status-fixture.html");
process.once("SIGINT", () => { for (const listener of listeners) listener.end(); void coordinator.stop().finally(async () => { await server.close(); db.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); }); });
