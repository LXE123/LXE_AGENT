// Run from repository root. Electron bridges IPC to this test gateway; Agent is a separate Bun process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
import jobFixture from "../../../../../packages/foundation/protocol/fixtures/valid-agent-job.json";
import { ProcessAgentRuntime } from "../../../../gateway/src/orchestration/process-runtime";
import { SessionScheduler } from "../../../../gateway/src/orchestration/scheduler";
const root = process.cwd();
const port = Number(process.env.LXE_QUESTION_FIXTURE_PORT ?? 5201);
const dataRoot = mkdtempSync(join(tmpdir(), "lxe-questions-"));
const workspace = { directory: root, worktree: root };
const states = new Map<string, string>();
const runtime = new ProcessAgentRuntime({
  command: process.execPath, arguments: [resolve("apps/agent-cli/test/fixtures-user-questions.ts")], cwd: root,
  environment: { ...process.env, LOCAL_LOGS_ENABLED: "0", LOG_LEVEL: "ERROR" },
  agentSoulPath: "/soul", skillsRoot: "/skills", userSkillsRoot: "/user-skills", lxeskillCatalogPath: "/catalog",
  llmConfigRoot: "/llm", dataRoot, legacyWorkspace: workspace,
});
const scheduler = new SessionScheduler({ runtime: {
  startTurn: async (job, handle) => {
    const outcome = await runtime.runTurn(job, handle).catch(() => ({ status: "error" }));
    scheduler.handleRuntimeEvent({ kind: "runtime.turn.completed", run_id: handle.runId,
      payload: { session_id: job.session_id, job_id: job.job_id, status: outcome.status } });
  },
  cancelTurn: handle => runtime.cancelTurn(handle), steerTurn: (handle, message) => runtime.steerTurn(handle, message),
}, onJobState: event => states.set(event.job.session_id, event.state) });
await runtime.start();
for (const id of ["a", "b", "c"]) await runtime.ensureSession({ session_id: id, source: { platform: "desktop" }, workspace });
let failAnswer = false, delayAnswer = false;
const vite = await createServer({ root: resolve("apps/dashboard"), server: { port, strictPort: true, host: "127.0.0.1" }, plugins: [{
  name: "user-question-fixture", configureServer(server) {
    server.middlewares.use("/__questions", async (req, res) => {
      try {
        let body = ""; for await (const chunk of req) body += chunk;
        const raw = JSON.parse(body);
        let result: unknown;
        if (raw.operation === "fixture.start") {
          const id = raw.input.session_id;
          const userInput = ["single", "all-single"].includes(raw.input.variant) ? `fixture:${raw.input.variant}` : "请帮我处理店铺";
          await runtime.ensureSession({ session_id: id, source: { platform: "desktop" }, workspace });
          await scheduler.enqueue({ ...jobFixture, job_id: crypto.randomUUID(), session_id: id, message_id: crypto.randomUUID(),
            user_input: userInput, user_content_blocks: [{ type: "text", text: userInput }], source: { platform: "desktop" }, response_route_id: "", workspace });
          result = true;
        } else if (raw.operation === "fixture.states") result = Object.fromEntries(states);
        else if (raw.operation === "fixture.fail-answer") { failAnswer = true; result = true; }
        else if (raw.operation === "fixture.delay-answer") { delayAnswer = true; result = true; }
        else if (raw.operation === "fixture.restart") {
          scheduler.setRuntimeReady(false); await runtime.stop();
          await runtime.start(); scheduler.setRuntimeReady(true); result = true;
        } else {
          const call = parseDashboardRpcCall(raw);
          if (call.operation === "sessions.stop") result = { stopped: await scheduler.requestStop(call.input.session_id, call.input.turn_id) };
          else if (call.operation === "sessions.answer" || call.operation === "sessions.questions" || call.operation === "sessions.detail" || call.operation === "sessions.list") {
            if (call.operation === "sessions.answer" && failAnswer) { failAnswer = false; throw new Error("Fixture transport disconnected before submit"); }
            result = await runtime.dashboardCall(call);
            if (call.operation === "sessions.answer" && delayAnswer) { delayAnswer = false; await Bun.sleep(1000); }
          } else throw new Error(`Unsupported fixture operation ${call.operation}`);
        }
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
  },
}] });
try { await vite.listen(); } catch (error) {
  await runtime.stop(); rmSync(dataRoot, { recursive: true, force: true }); throw error;
}
console.log(`Question acceptance: http://127.0.0.1:${port}/test/features/sessions/user-questions-fixture.html`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  void runtime.stop().then(() => vite.close()).finally(() => { rmSync(dataRoot, { recursive: true, force: true }); process.exit(0); });
});
