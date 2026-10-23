import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import { AtomicRuntimeProviderManager, buildProviderRequest, loadProviderDescriptor } from "../../src/providers/provider";
import { buildCompletionsRequest } from "../../src/providers/completions-provider";
import { buildResponsesRequest } from "../../src/providers/responses-provider";
import { messageFixture } from "../message-fixtures";

const request = { system: "title", messages: [], tools: [], toolChoice: "none" as const, signal: new AbortController().signal };
test("all protocol adapters apply auxiliary limits without changing the main request descriptor", () => {
  for (const [provider, model, build, outputKey] of [
    ["kimi_coding", "kimi-for-coding", buildProviderRequest, "max_tokens"],
    ["zhipuai_coding_plan", "glm-5.3-flash", buildCompletionsRequest, "max_tokens"],
    ["deepseek", "deepseek-v4-flash", buildResponsesRequest, "max_output_tokens"],
  ] as const) {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), { AGENT_LLM_PROVIDER: provider, AGENT_LLM_MODEL: model }, { deferCredential: true });
    const before = structuredClone(descriptor);
    const main = build(descriptor, request);
    const auxiliary = build(descriptor, { ...request, auxiliary: { maxOutputTokens: 4096, reasoning: "minimum" } });
    expect(auxiliary[outputKey]).toBe(4096);
    expect(auxiliary.tools).toBeUndefined();
    expect(build(descriptor, request)).toEqual(main);
    expect(descriptor).toEqual(before);
    if (provider === "kimi_coding") expect(auxiliary.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });
  }
});

test("a main turn and its title share one credential snapshot while the next turn sees new auth", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-title-credentials-"));
  try {
    mkdirSync(join(root, "config")); const authPath = join(root, "config/auth.json"); const observed: string[] = [];
    const manager = new AtomicRuntimeProviderManager(repositoryRoot(import.meta.dir),
      { AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-flash" }, descriptor => ({
        turn: async () => { observed.push(descriptor.apiKey); return messageFixture(); },
        summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
      }), undefined, authPath);
    writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "first" } }));
    const captured = manager.acquire().provider.captureForTurn!();
    await captured.turn(request);
    writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "second" } }));
    await captured.turn({ ...request, auxiliary: { maxOutputTokens: 4096, reasoning: "minimum" } });
    await manager.acquire().provider.captureForTurn!().turn(request);
    expect(observed).toEqual(["first", "first", "second"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
