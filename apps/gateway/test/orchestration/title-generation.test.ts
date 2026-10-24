import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProcessAgentRuntime } from "../../src/orchestration/process-runtime";

test("existing agentcli process generates names over JSON-RPC using the actual tool-free provider adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-title-rpc-"));
  const requests: Record<string, any>[] = []; let rejectRequest = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, any>);
    if (rejectRequest) return Response.json({ error: { message: "Fixture: title denied api_key=private-fixture-key", type: "authentication_error" } }, { status: 401 });
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "title", object: "chat.completion.chunk", created: 0, model: "glm-5.3-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "每日运营简报" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  const llm = join(root, "llm"), skills = join(root, "skills");
  cpSync(resolve("config/llm"), llm, { recursive: true }); mkdirSync(skills);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config/auth.json"), JSON.stringify({ zhipuai_coding_plan: { type: "api_key", key: "fixture-only" } }));
  const path = join(llm, "providers/zhipuai-coding-plan.json");
  const config = JSON.parse(readFileSync(path, "utf8")); config.base_url = `http://127.0.0.1:${server.port}/v1`;
  writeFileSync(path, JSON.stringify(config));
  const runtime = new ProcessAgentRuntime({ command: process.execPath, arguments: [resolve("apps/agent-cli/src/main.ts")],
    cwd: process.cwd(), environment: { PATH: process.env.PATH, LOCAL_LOGS_ENABLED: "0", AGENT_LLM_PROVIDER: "zhipuai_coding_plan",
      AGENT_LLM_MODEL: "glm-5.3-flash", ZHIPUAI_CODING_PLAN_API_KEY: "fixture-only" },
    dataRoot: root, skillsRoot: skills, userSkillsRoot: join(root, "user"), llmConfigRoot: llm,
    legacyWorkspace: { directory: root, worktree: root },
  });
  try {
    await runtime.start(); const pid = runtime.status().pid;
    expect((await runtime.dashboardCall({ operation: "sessions.list", input: {} })).items).toHaveLength(0);
    expect(await runtime.dashboardCall({ operation: "titles.generate", input: { text: "每天总结运营数据" } })).toEqual({ title: "每日运营简报" });
    expect(runtime.status().pid).toBe(pid);
    expect((await runtime.dashboardCall({ operation: "sessions.list", input: {} })).items).toHaveLength(0);
    expect(requests).toHaveLength(1); expect(requests[0]!.tools).toBeUndefined();
    expect(requests[0]!.messages).toHaveLength(2);
    expect(requests[0]!.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("scheduled task") });
    expect(JSON.stringify(requests[0]!.messages[1])).toContain("每天总结运营数据");
    expect(requests[0]!.max_tokens).toBe(4096);
    await runtime.dashboardCall({ operation: "titles.generate", input: { text: "指定模型", model: { provider: "zhipuai_coding_plan", model: "glm-5.3", credential_source: "local" } } });
    expect(requests[1]!.model).toBe("glm-5.3");
    expect((await runtime.dashboardCall({ operation: "models.current", input: {} })).model).toBe("glm-5.3-flash");
    rejectRequest = true;
    const error = await runtime.dashboardCall({ operation: "titles.generate", input: { text: "error" } }).catch(error => error);
    expect(String(error)).toContain("Fixture: title denied"); expect(String(error)).not.toContain("private-fixture-key");
    expect(runtime.status().pid).toBe(pid);
  } finally { await runtime.stop(); server.stop(true); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
}, 30_000);
