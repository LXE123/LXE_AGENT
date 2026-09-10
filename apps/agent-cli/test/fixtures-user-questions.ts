// Deterministic model; real engine, SQLite, question tool, Dashboard service and JSON-RPC server.
import { createInterface } from "node:readline";
import { join } from "node:path";
import { AgentProtocolServer } from "../src/server";
import { DashboardService } from "../src/dashboard-service";
import { SqliteRuntimeStore, ToolRegistry, TypeScriptAgentRuntime, UserQuestionService, registerUserQuestionTool } from "@lxe/runtime";
console.log = (...values: unknown[]) => { process.stderr.write(values.map(String).join(" ") + "\n"); };
const server = new AgentProtocolServer({
  environment: { LOCAL_LOGS_ENABLED: "0", LOG_LEVEL: "ERROR" },
  write: message => { process.stdout.write(JSON.stringify(message) + "\n"); },
  exit: code => process.exit(code),
  createHost: options => {
    const store = new SqliteRuntimeStore(join(options.dataRoot, "agent.sqlite3"));
    const tools = new ToolRegistry();
    const questions = new UserQuestionService(id => { void options.onSessionChanged?.(id, "questions"); });
    registerUserQuestionTool(tools, questions);
    const runtime = new TypeScriptAgentRuntime({ store, tools, emitter: options.emitter, systemPrompt: "Test fixture",
      onSessionChanged: (id, change) => options.onSessionChanged?.(id, change),
      provider: {
        summarize: async () => ({ text: "Fixture summary", usage: { input_tokens: 0, output_tokens: 0 } }),
        turn: async request => {
          const ask = request.messages.at(-1)?.role !== "tool";
          return { id: crypto.randomUUID(), role: "assistant", timestamp: Date.now(), api: "anthropic_messages", provider: "fixture", model: "fixture",
            stopReason: ask ? "toolUse" : "stop", usage: { input_tokens: 1, output_tokens: 1, status: "complete" },
            content: ask ? [{ type: "tool_call", id: crypto.randomUUID(), name: "ask_user_question", arguments: { questions: [
              { id: "one", header: "运行范围", question: "先处理哪个店铺？", options: [{ label: "店铺 A", description: "先完成一间店铺" }, { label: "店铺 B" }] },
              { id: "many", question: "需要哪些输出？", multi_select: true, options: [{ label: "表格" }, { label: "摘要" }] },
              { id: "text", question: "还有什么需要注意？" },
            ] } }] : [{ type: "text", text: "已收到回答，继续完成任务。" }],
          };
        },
      },
    });
    const dashboard = new DashboardService({ stateRoot: options.dataRoot, llmConfigRoot: options.llmConfigRoot,
      skillsRoot: options.skillsRoot, userSkillsRoot: options.userSkillsRoot, environment: options.environment,
      store, tools, questions, mcpConfig: { servers: [] } });
    return {
      start: () => runtime.start(), stop: async () => { await questions.stop(); await runtime.stop(); },
      runTurn: (job, handle) => runtime.runTurn(job, handle),
      ensureSession: request => store.ensureSession(request),
      appendPendingEvent: (id, event) => store.appendPendingEvent(id, event),
      hasPendingEvents: id => store.hasPendingEvents(id),
      resolveArtifact: async () => undefined, resolveAttachment: async () => undefined,
      dashboardCall: call => dashboard.call(call), updateSkillPermissions: () => {}, health: () => ({ ready: true }),
    };
  },
});
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim()) void server.accept(line);
}
await server.shutdown();
