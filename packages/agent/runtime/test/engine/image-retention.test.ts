import { PermissionPolicyService } from "../../src/permissions/policy";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentJob, JsonObject } from "@lxe/protocol";
import { TypeScriptAgentRuntime } from "../../src/engine/runtime";
import type { RuntimeMessage, RuntimeProvider } from "../../src/engine/types";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { ToolRegistry } from "../../src/tooling/registry";
import { registerCodingTools } from "../../src/tooling/coding-tools";
import { adaptMessagesForProvider, type ProviderDescriptor } from "../../src/providers/provider";
import { adaptMessagesForCompletions } from "../../src/providers/completions-provider";
import { adaptMessagesForResponses } from "../../src/providers/responses-provider";
import { messageFixture } from "../message-fixtures";
import { resolveWorkspaceContext } from "@lxe/core";
import { removeTemporaryRoot } from "../temp-directory";

const imageData = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(imageData);
  if (!value || typeof value !== "object") return [];
  const block = value as JsonObject;
  if (block.type === "image") return [String((block.source as JsonObject).data)];
  return Object.values(block).flatMap(imageData);
};

for (const cancelled of [false, true]) {
  test(`images survive ${cancelled ? "cancellation" : "turn completion"}, next turn and cold replay without leaking to desktop`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lxe-image-retention-"));
    const imagePath = join(root, "source.png"), dbPath = join(root, "agent.sqlite3");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
    await writeFile(imagePath, Buffer.from(png, "base64"));
    const image: JsonObject = { type: "image", source: { type: "base64", media_type: "image/png", data: png } };
    const attachment: JsonObject = { type: "local_file", attachment_id: "a1", turn_id: "t1", path: imagePath, name: "source.png", size_bytes: 68, media_type: "image/png", ts: 1 };
    const tools = new ToolRegistry();
    const processes = registerCodingTools(tools, {});
    tools.register({ name: "mcp_image", source: "mcp", exposure: "direct", description: "image fixture", input_schema: { type: "object" }, execute: async () => ({ content: [image] }) });
    const controller = new AbortController();
    const handle = () => ({ signal: controller.signal, get cancelled() { return controller.signal.aborted; }, drainSteering: () => [], registerProcess: () => () => {} });
    const job = (turn: string, blocks: JsonObject[] = []): AgentJob => ({ job_id: turn, session_id: "s1", session_key: "s1", response_route_id: "r1", user_id: "u1", conversation_id: "c1", is_group: false, message_id: turn, user_input: "look", job_kind: "turn", sender_nick: "test", source: { platform: "desktop" }, raw_data: {}, user_content_blocks: blocks, diagnostics: [], workspace: resolveWorkspaceContext(root) });
    const requests: RuntimeMessage[][] = [], stream: unknown[] = [];
    let calls = 0;
    const provider: RuntimeProvider = {
      summarize: async () => { throw new Error("unexpected compaction"); },
      turn: async request => {
        requests.push(structuredClone(request.messages));
        if (calls++ === 0) return messageFixture({ content: [
          { type: "tool_call", id: "read-1", name: "read", arguments: { path: imagePath } },
          { type: "tool_call", id: "mcp-1", name: "mcp_image", arguments: {} },
        ], stopReason: "toolUse" });
        if (cancelled && calls === 2) {
          controller.abort(new DOMException("Aborted", "AbortError"));
          throw controller.signal.reason;
        }
        return messageFixture({ content: [{ type: "text", text: "visual findings" }], stopReason: "stop" });
      },
    };
    let store = new SqliteRuntimeStore(dbPath);
    const makeRuntime = () => new TypeScriptAgentRuntime({ permissionPolicy: new PermissionPolicyService(), store, tools, provider, systemPrompt: "test", emitter: { emit: async () => {}, typing: async () => {}, desktopStream: async batch => { stream.push(batch); } } });
    let runtime = makeRuntime();
    try {
      await runtime.start();
      await store.ensureSession({ session_id: "s1", source: { platform: "desktop" }, workspace: resolveWorkspaceContext(root) });
      const outcome = await runtime.runTurn(job("t1", [attachment, image, { type: "text", text: "look" }]), handle());
      expect(outcome.status).toBe(cancelled ? "cancelled" : "completed");
      const saved = await store.loadMessages("s1");
      expect(imageData(saved)).toEqual([png, png, png]);
      expect(await store.loadMessages("s1")).toEqual(saved);
      expect(imageData(requests[1])).toEqual([png, png, png]);
      expect(JSON.stringify(stream)).not.toContain(png);
      const display = await store.sessionDetail("s1", { limit: 10 });
      expect(JSON.stringify(display)).not.toContain(png);
      expect(JSON.stringify(display)).toContain("attachment_id");
      expect(JSON.stringify(display)).toContain("image_views");
      const userDisplay = (display!.messages as JsonObject[]).find(message => Array.isArray(message.attachments));
      expect(userDisplay!.content).toEqual([{ type: "text", text: "look" }]);
      const descriptor: ProviderDescriptor = {
        name: "test", model: "test", apiStyle: "anthropic_messages", baseURL: "https://example.invalid", apiKey: "test",
        maxTokens: 1000, defaultHeaders: {}, thinkingStyle: "none", thinkingLevels: [], thinkingDefault: "off",
        thinkingEnabled: false, thinkingEffort: "off", thinkingDisplay: "omitted", contextWindowTokens: 10000, requestIdleTimeoutMs: 1000,
      };
      for (const adapt of [
        (vision: boolean) => adaptMessagesForProvider(saved, { ...descriptor, supportsVision: vision }),
        (vision: boolean) => adaptMessagesForCompletions(saved, vision, descriptor),
        (vision: boolean) => adaptMessagesForResponses(saved, vision, descriptor),
      ]) {
        expect(JSON.stringify(adapt(false))).not.toContain(png);
        expect(JSON.stringify(adapt(true)).split(png)).toHaveLength(4);
        expect(await store.loadMessages("s1")).toEqual(saved);
      }
      // A context patch must preserve images as well as ordinary message appends.
      await store.replaceMessages("s1", saved, "repair");
      expect(await store.loadMessages("s1")).toEqual(saved);
      if (!cancelled) {
        await writeFile(imagePath, "overwritten source");
        await runtime.runTurn(job("t2"), handle());
        expect(imageData(requests.at(-1))).toEqual([png, png, png]);
      }
      await runtime.stop();
      await unlink(imagePath);
      store = new SqliteRuntimeStore(dbPath);
      runtime = makeRuntime();
      await runtime.start();
      expect(imageData(await store.loadMessages("s1"))).toEqual([png, png, png]);
      const liveHandle = { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} };
      expect((await runtime.runTurn(job("t3"), liveHandle)).status).toBe("completed");
      expect(imageData(requests.at(-1))).toEqual([png, png, png]);
      expect(JSON.stringify((await store.sessionDetail("s1", { limit: 1 }))?.messages)).not.toContain(png);
      const transcript = await readFile(join(root, "session_transcripts", "s1.jsonl"), "utf8");
      expect(transcript).toContain(png);
      expect(transcript).not.toContain("processed_history_images");
    } finally {
      await runtime.stop();
      await processes.stop();
      await removeTemporaryRoot(root);
    }
  }, 15_000);
}
