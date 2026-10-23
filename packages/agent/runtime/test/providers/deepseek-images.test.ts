import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { DeepSeekFilesService, deepseekImage, DEEPSEEK_FILE_TTL_SECONDS } from "../../src/providers/deepseek-files";
import { DeepSeekUploadIndex } from "../../src/providers/deepseek-upload-index";
import { DeepSeekImageRequest, DEEPSEEK_IMAGE_LIMITS } from "../../src/providers/deepseek-image-request";
import { buildResponsesRequest, ResponsesRuntimeProvider, type ResponsesClientPort } from "../../src/providers/responses-provider";
import { normalizeProviderError, type ProviderDescriptor } from "../../src/providers/provider";
import { configureRuntimeWireTracing } from "../../src/providers/wire-trace";
import type { RuntimeMessage, RuntimeProviderRequest, AssistantMessageEvent } from "../../src/engine/types";

const MiB = 1024 * 1024;
const folders: string[] = [];
const services: DeepSeekFilesService[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "deepseek-files-"));
  folders.push(path);
  return path;
};
const service = (options: ConstructorParameters<typeof DeepSeekFilesService>[0] = {}): DeepSeekFilesService => {
  const result = new DeepSeekFilesService(options);
  services.push(result);
  return result;
};
const descriptor = (patch: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  name: "deepseek", model: "deepseek-flash", apiStyle: "openai_responses",
  baseURL: "https://example.invalid/v1", apiKey: "secret-test-key", defaultHeaders: {},
  supportsVision: true, maxTokens: 1_000, thinkingStyle: "provider-managed", thinkingLevels: ["off"],
  thinkingDefault: "off", thinkingEnabled: false, thinkingEffort: "off", thinkingDisplay: "omitted",
  contextWindowTokens: 1_000_000, requestIdleTimeoutMs: 1_000, ...patch,
});
const signal = (): AbortSignal => new AbortController().signal;
const imageBlock = (bytes = 12, value = 1): JsonObject => ({
  type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(bytes, value).toString("base64") },
});
const request = (messages: RuntimeMessage[], overrides: Partial<RuntimeProviderRequest> = {}): RuntimeProviderRequest => ({
  system: "system", messages, tools: [], toolChoice: "auto", signal: signal(), ...overrides,
});
const final = { id: "resp_ok", status: "completed", output: [{ id: "msg_ok", type: "message", role: "assistant",
  content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 1 } };
const client = (handler: (body: Record<string, unknown>, attempt: number) => unknown): ResponsesClientPort => {
  let attempts = 0;
  return { responses: { stream(body) {
    const attempt = ++attempts;
    return { on() {}, async finalResponse() { return await handler(body, attempt); } };
  } } };
};
const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });
function uploadMock(now: () => number = Date.now) {
  const calls: Array<{ url: string; headers: Headers; form: FormData; signal: AbortSignal }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = init!.body as FormData;
    const file = form.get("file") as File;
    calls.push({ url: String(url), headers: new Headers(init!.headers), form, signal: init!.signal! });
    expect(init!.redirect).toBe("error");
    const created = Math.floor(now() / 1_000);
    return Response.json({ id: `file-api-${calls.length}`, object: "file", bytes: file.size,
      created_at: created, expires_at: created + DEEPSEEK_FILE_TTL_SECONDS, purpose: "user_data", filename: file.name });
  }) as typeof fetch;
  return { calls, fetch: fetcher };
}

describe("DeepSeek Files cache", () => {
  test("uploads multipart with seven-day expiry, reuses across restarts, and scopes credentials/endpoints", async () => {
    const root = await directory();
    const cachePath = join(root, "deepseek-files.json");
    const remote = uploadMock();
    const image = deepseekImage("image/png", new Uint8Array([1, 2, 3]));
    const first = service({ cachePath, fetch: remote.fetch });
    expect(await first.resolve(descriptor(), image, signal())).toBe("file-api-1");
    first.close();
    const next = service({ cachePath, fetch: remote.fetch });
    expect(await next.resolve(descriptor(), image, signal())).toBe("file-api-1");
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]!.url).toBe("https://example.invalid/v1/files");
    expect(remote.calls[0]!.headers.get("authorization")).toBe("Bearer secret-test-key");
    expect(remote.calls[0]!.headers.has("content-type")).toBe(false);
    expect(remote.calls[0]!.form.get("purpose")).toBe("user_data");
    expect(remote.calls[0]!.form.get("expires_after[anchor]")).toBe("created_at");
    expect(remote.calls[0]!.form.get("expires_after[seconds]")).toBe("604800");
    await next.resolve(descriptor({ apiKey: "different-key" }), image, signal());
    await next.resolve(descriptor({ baseURL: "https://gateway.invalid/api" }), image, signal());
    await next.resolve(descriptor({ defaultHeaders: { "x-account": "another" } }), image, signal());
    expect(remote.calls).toHaveLength(4);
    const stored = await readFile(cachePath, "utf8");
    expect(stored).not.toContain("secret-test-key");
    expect(stored).not.toContain("different-key");
    expect(stored).not.toContain("example.invalid");
    expect(JSON.parse(stored).records).toHaveLength(4);
  });

  test("refreshes within one hour of expiry and prunes old mappings on commit", async () => {
    let now = Date.now();
    const root = await directory();
    const cachePath = join(root, "files.json");
    const remote = uploadMock(() => now);
    const files = service({ cachePath, fetch: remote.fetch, now: () => now });
    const image = deepseekImage("image/png", new Uint8Array([1]));
    const other = deepseekImage("image/png", new Uint8Array([2]));
    await files.resolve(descriptor(), image, signal());
    await files.resolve(descriptor(), other, signal());
    now += (DEEPSEEK_FILE_TTL_SECONDS - 3_601) * 1_000;
    expect(await files.resolve(descriptor(), image, signal())).toBe("file-api-1");
    now += 2_000;
    expect(await files.resolve(descriptor(), image, signal())).toBe("file-api-3");
    expect(JSON.parse(await readFile(cachePath, "utf8")).records).toHaveLength(1);
    // A stale response must not evict the newly installed generation.
    await files.invalidate(descriptor(), image, "file-api-1");
    expect(await files.resolve(descriptor(), image, signal())).toBe("file-api-3");
  });

  test("shares an upload while cancellation detaches only the cancelling waiter", async () => {
    const remote = uploadMock();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let uploadSignal!: AbortSignal;
    let calls = 0;
    const files = service({ fetch: (async (url, init) => {
      calls++;
      uploadSignal = init!.signal!;
      started();
      await gate;
      return remote.fetch(url, init);
    }) as typeof fetch });
    const image = deepseekImage("image/png", new Uint8Array([1]));
    const cancel = new AbortController();
    const one = files.resolve(descriptor(), image, cancel.signal).catch(error => error);
    const two = files.resolve(descriptor(), image, signal());
    await entered;
    cancel.abort(new DOMException("Stopped", "AbortError"));
    expect((await one).name).toBe("AbortError");
    expect(uploadSignal.aborted).toBe(false);
    release();
    expect(await two).toBe("file-api-1");
    expect(calls).toBe(1);
  });

  test("rebuilds a corrupt JSON cache and serializes independent writers without losing records", async () => {
    const root = await directory();
    const path = join(root, "files.json");
    await writeFile(path, "{truncated");
    const records = Array.from({ length: 8 }, (_, i) => ({ scope: "a".repeat(64), imageKey: String(i).repeat(64),
      fileId: `file-${i}`, bytes: 1, createdAt: 1_000, expiresAt: 10_000 }));
    await Promise.all(records.map(record => new DeepSeekUploadIndex(path).commit(record, 1_000, signal())));
    expect(JSON.parse(await readFile(path, "utf8")).records).toHaveLength(8);
    expect((await readdir(root)).sort()).toEqual(["files.json"]);
  });

  test("rejects invalid upload metadata instead of caching an unusable id", async () => {
    const files = service({ fetch: (async () => Response.json({ id: "oops" })) as unknown as typeof fetch });
    await expect(files.resolve(descriptor(), deepseekImage("image/png", new Uint8Array([1])), signal()))
      .rejects.toThrow("Invalid DeepSeek Files response metadata");
  });

  test("recovers a dead writer's lock and respects an active writer's cancellation", async () => {
    const root = await directory();
    const path = join(root, "files.json");
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    await writeFile(`${path}.lock`, `${child.pid}:deadbeef\n`);
    const index = new DeepSeekUploadIndex(path);
    const candidate = { scope: "a".repeat(64), imageKey: "b".repeat(64), fileId: "file-1", bytes: 1, createdAt: 1_000, expiresAt: 10_000 };
    await index.commit(candidate, 1_000, signal());
    expect((await index.get(candidate.scope, candidate.imageKey, 1_000))?.fileId).toBe("file-1");
    await writeFile(`${path}.lock`, `${process.pid}:abcdef\n`);
    const cancel = new AbortController();
    const pending = index.invalidate(candidate.scope, candidate.imageKey, candidate.fileId, cancel.signal);
    cancel.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toThrow();
    expect(await readFile(`${path}.lock`, "utf8")).toBe(`${process.pid}:abcdef\n`);
  });
});

describe("DeepSeek request image projection", () => {
  test("real SDK sends multipart uploads and file references through HTTP, with separate stale-retry traces", async () => {
    const root = await directory();
    const uploads: number[] = [];
    const payloads: JsonObject[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer secret-test-key");
      if (new URL(req.url).pathname === "/v1/files") {
        const form = await req.formData();
        const file = form.get("file") as File;
        uploads.push(file.size);
        expect(form.get("expires_after[seconds]")).toBe("604800");
        const created = Math.floor(Date.now() / 1_000);
        return Response.json({ id: `file-api-${uploads.length}`, object: "file", bytes: file.size,
          purpose: "user_data", created_at: created, expires_at: created + 604800 });
      }
      const payload = await req.json() as JsonObject;
      payloads.push(payload);
      if (payloads.length === 1) return Response.json({ error: { type: "invalid_request_error", message: "file-api-1 expired" } }, { status: 400 });
      const events = [{ type: "response.created", response: { id: "resp_ok", status: "in_progress", output: [] } },
        { type: "response.completed", response: final }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const providerDescriptor = descriptor({ baseURL: `http://127.0.0.1:${server.port}/v1` });
      const files = service({ cachePath: join(root, "files.json") });
      const trace = configureRuntimeWireTracing({ projectRoot: root, environment: { LOCAL_LOGS_ENABLED: "1" } })
        .startTurn("session", "turn").startProviderAttempt({ step: 0, attempt: 1, provider: "deepseek", model: "deepseek-flash",
          endpoint: `${providerDescriptor.baseURL}/responses`, timeoutMs: 1_000 })!;
      const result = await new ResponsesRuntimeProvider(providerDescriptor, undefined, files)
        .turn(request([{ role: "user", content: [imageBlock()] }], { wireTrace: trace }));
      expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
      expect(uploads).toEqual([12, 12]);
      expect(payloads).toHaveLength(2);
      expect(JSON.stringify(payloads[0])).toContain('"file_id":"file-api-1"');
      expect(JSON.stringify(payloads[1])).toContain('"file_id":"file-api-2"');
      expect(JSON.stringify(payloads)).not.toContain("data:image");
      const traces = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true }));
      expect(traces).toHaveLength(2);
      for (const path of traces) {
        const entries = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(entries.filter(entry => entry.kind === "request_start")).toHaveLength(1);
        expect(entries.filter(entry => entry.kind === "request_end")).toHaveLength(1);
        expect(JSON.stringify(entries)).not.toContain("secret-test-key");
        if (path.includes("request_2")) expect(entries.at(-1).ok).toBe(true);
        else expect(entries.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("file-api-1 expired") });
      }
    } finally { await server.stop(true); }
  });

  test("switching a >50 MiB history to DeepSeek uploads all images and leaves GLM history untouched", async () => {
    const messages: RuntimeMessage[] = [{ role: "user", content: [imageBlock(1_200_000)] }];
    for (let i = 1; i < 33; i++) messages.push({ role: "tool", content: [{ type: "tool_result", tool_call_id: `call_${i}`,
      content: [imageBlock(1_200_000, i + 1)] }] });
    const original = JSON.stringify(messages);
    const inline = buildResponsesRequest(descriptor({ name: "glm" }), request(messages));
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeGreaterThan(50 * MiB);
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    let deepseekBytes = 0;
    const provider = new ResponsesRuntimeProvider(descriptor(), client(body => {
      const encoded = JSON.stringify(body);
      deepseekBytes = Buffer.byteLength(encoded);
      expect(encoded).not.toContain("data:image");
      expect(encoded.match(/file_id/gu)).toHaveLength(33);
      return final;
    }), files);
    await provider.turn(request(messages));
    expect(remote.calls).toHaveLength(33);
    expect(deepseekBytes).toBeLessThan(20_000);
    await provider.turn(request(messages));
    expect(remote.calls).toHaveLength(33);
    let glmBytes = 0;
    await new ResponsesRuntimeProvider(descriptor({ name: "glm" }), client(body => {
      glmBytes = Buffer.byteLength(JSON.stringify(body));
      expect(JSON.stringify(body)).not.toContain("file_id");
      return final;
    }), files).turn(request(messages));
    expect(glmBytes).toBeGreaterThan(50 * MiB);
    expect(JSON.stringify(messages)).toBe(original);
  });

  test("Files failure applies the inline budget before dispatch and preserves exact historical recovery copies", async () => {
    const root = await directory();
    let uploads = 0;
    const files = service({ imageDirectory: root, fetch: (async () => { uploads++; throw new Error("Files unavailable fixture"); }) as unknown as typeof fetch });
    const messages: RuntimeMessage[] = [{ role: "user", content: Array.from({ length: 8 }, (_, i) => imageBlock(3 * MiB, i)) }];
    const original = JSON.stringify(messages);
    let omitted = 0;
    let body!: Record<string, unknown>;
    await new ResponsesRuntimeProvider(descriptor(), client(value => { body = value; return final; }), files)
      .turn(request(messages, { onRequestImagesOmitted: count => { omitted = count; } }));
    expect(uploads).toBe(1);
    expect(omitted).toBe(5); // 32 MiB -> remove at least the rounded 20 MiB excess.
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(20 * MiB);
    const parts = (body.input as JsonObject[])[0]!.content as JsonObject[];
    expect(parts.slice(0, 5).every(part => part.type === "input_text")).toBe(true);
    expect(parts.slice(5).every(part => part.type === "input_image")).toBe(true);
    const key = deepseekImage("image/png", Buffer.alloc(3 * MiB, 0)).key;
    expect(await readFile(join(root, `${key}.png`))).toEqual(Buffer.alloc(3 * MiB, 0));
    expect(JSON.stringify(messages)).toBe(original);
  });

  test("a partial upload failure falls back request-wide, retaining successful cache entries", async () => {
    const remote = uploadMock();
    let uploads = 0;
    const files = service({ fetch: (async (url, init) => {
      if (++uploads === 2) return new Response("quota fixture", { status: 429 });
      return remote.fetch(url, init);
    }) as typeof fetch });
    const messages: RuntimeMessage[] = [{ role: "user", content: [imageBlock(12, 1), imageBlock(12, 2)] }];
    const provider = new ResponsesRuntimeProvider(descriptor(), client((body, attempt) => {
      const encoded = JSON.stringify(body);
      expect(encoded.includes("file_id")).toBe(attempt === 2);
      expect(encoded.includes("data:image")).toBe(attempt === 1);
      return final;
    }), files);
    await provider.turn(request(messages));
    await provider.turn(request(messages));
    expect(uploads).toBe(3);
  });

  test("stale ids are reuploaded once, without emitting a failed assistant message", async () => {
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    const messages: RuntimeMessage[] = [{ role: "user", content: [imageBlock()] }];
    const events: AssistantMessageEvent[] = [];
    let attempts = 0;
    await new ResponsesRuntimeProvider(descriptor(), client((body, attempt) => {
      attempts++;
      expect(JSON.stringify(body)).toContain(`file-api-${attempt}`);
      if (attempt === 1) throw httpError(400, "file-api-1 expired");
      return final;
    }), files).turn(request(messages, { onEvent: event => { events.push(event); } }));
    expect(attempts).toBe(2);
    expect(remote.calls).toHaveLength(2);
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
    expect(events.filter(event => event.type === "done")).toHaveLength(1);
    let failed = 0;
    await expect(new ResponsesRuntimeProvider(descriptor(), client(() => {
      failed++; throw httpError(400, "invalid file_id: expired");
    }), files).turn(request(messages))).rejects.toThrow("invalid file_id: expired");
    expect(failed).toBe(2);
    // Even the second stale generation is invalidated for a future user retry.
    expect(await files.resolve(descriptor(), deepseekImage("image/png", Buffer.alloc(12, 1)), signal())).toBe("file-api-4");
  });

  test("invalidates only an exactly named id, avoiding substring matches", async () => {
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    const messages: RuntimeMessage[] = [{ role: "user", content: [imageBlock(12, 1), imageBlock(12, 2)] }];
    await new ResponsesRuntimeProvider(descriptor(), client((body, attempt) => {
      if (attempt === 1) throw httpError(404, "file-api-2 not found");
      expect(JSON.stringify(body)).toContain("file-api-1");
      expect(JSON.stringify(body)).toContain("file-api-3");
      return final;
    }), files).turn(request(messages));
    expect(remote.calls).toHaveLength(3);
  });

  test.each([401, 403, 413, 429, 500])("does not retry a %i model failure as stale Files state", async status => {
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    let attempts = 0;
    const message = status === 413 ? "413 Failed to buffer the request body: length limit exceeded" : "file_id invalid fixture";
    await expect(new ResponsesRuntimeProvider(descriptor(), client(() => {
      attempts++; throw httpError(status, message);
    }), files).turn(request([{ role: "user", content: [imageBlock()] }]))).rejects.toThrow(message);
    expect(attempts).toBe(1);
    expect(remote.calls).toHaveLength(1);
    if (status === 413) {
      const failure = normalizeProviderError(httpError(status, message), descriptor());
      expect(failure.contextOverflow).toBe(false);
      expect(failure.retryable).toBe(false);
      expect(failure.message).toBe(message);
      expect(failure.category).toBe("请求体过大");
    }
  });

  test("file upload has its own timeout and does not spend the model idle timeout", async () => {
    const remote = uploadMock();
    const files = service({ fetch: (async (url, init) => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return remote.fetch(url, init);
    }) as typeof fetch });
    await expect(new ResponsesRuntimeProvider(descriptor({ requestIdleTimeoutMs: 5 }), client(() => final), files)
      .turn(request([{ role: "user", content: [imageBlock()] }]))).resolves.toMatchObject({ stopReason: "stop" });
    const timeoutFiles = service({ uploadTimeoutMs: 5, fetch: ((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch });
    await new ResponsesRuntimeProvider(descriptor(), client(body => {
      expect(JSON.stringify(body)).toContain("data:image"); return final;
    }), timeoutFiles).turn(request([{ role: "user", content: [imageBlock()] }]));
  });

  test("cancelling an upload does not fall back or send a model request", async () => {
    const cancel = new AbortController();
    const files = service({ fetch: ((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      cancel.abort(new DOMException("User stopped", "AbortError"));
    })) as typeof fetch });
    let modelCalls = 0;
    await expect(new ResponsesRuntimeProvider(descriptor(), client(() => { modelCalls++; return final; }), files)
      .turn(request([{ role: "user", content: [imageBlock()] }], { signal: cancel.signal }))).rejects.toThrow("User stopped");
    expect(modelCalls).toBe(0);
  });

  test("summary uses the same Files preparation and bounded stale recovery", async () => {
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    const result = await new ResponsesRuntimeProvider(descriptor(), client((body, attempt) => {
      expect(JSON.stringify(body)).not.toContain("data:image");
      if (attempt === 1) throw httpError(400, "file-api-1 deleted");
      return final;
    }), files).summarize({ messages: [{ role: "user", content: [imageBlock()] }], signal: signal(), kind: "history", maxOutputTokens: 100 });
    expect(result.text).toBe("ok");
    expect(remote.calls).toHaveLength(2);
  });

  test("request-wide count and raw-byte budgets count repeated image occurrences", async () => {
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    const parameters = buildResponsesRequest(descriptor(), request([{ role: "user", content: Array.from({ length: 601 }, () => imageBlock()) }]));
    const images = new DeepSeekImageRequest(descriptor(), files, parameters, signal());
    await images.prepare();
    expect(images.omittedCount).toBe(20);
    expect(remote.calls).toHaveLength(1);
    const large = buildResponsesRequest(descriptor(), request([{ role: "user", content: Array.from({ length: 129 }, () => imageBlock(MiB)) }]));
    const largeImages = new DeepSeekImageRequest(descriptor(), files, large, signal());
    await largeImages.prepare();
    expect(largeImages.omittedCount).toBe(64);
    expect(JSON.stringify(large).match(/file_id/gu)).toHaveLength(65);
  });

  test("measures the full UTF-8 JSON body and rejects non-image overflow before dispatch", async () => {
    const remote = uploadMock();
    const files = service({ fetch: remote.fetch });
    const parameters = buildResponsesRequest(descriptor(), request([{ role: "user", content: "中".repeat(1_000) }]));
    const exact = Buffer.byteLength(JSON.stringify(parameters));
    await expect(new DeepSeekImageRequest(descriptor(), files, parameters, signal(), undefined,
      { ...DEEPSEEK_IMAGE_LIMITS, bodyBytes: exact }).prepare()).resolves.toBeUndefined();
    await expect(new DeepSeekImageRequest(descriptor(), files, parameters, signal(), undefined,
      { ...DEEPSEEK_IMAGE_LIMITS, bodyBytes: exact - 1 }).prepare()).rejects.toThrow("after omitting all images");
    expect(remote.calls).toHaveLength(0);
  });

  test("inline budget accepts exactly 20 MiB and the complete body guard includes surrounding text", async () => {
    const files = service({ fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch });
    const exact = buildResponsesRequest(descriptor(), request([{ role: "user", content: [imageBlock(15 * MiB)] }]));
    const exactProjection = new DeepSeekImageRequest(descriptor(), files, exact, signal());
    await exactProjection.prepare();
    expect(exactProjection.omittedCount).toBe(0);
    const above = buildResponsesRequest(descriptor(), request([{ role: "user", content: [imageBlock(15 * MiB + 1)] }]));
    const aboveProjection = new DeepSeekImageRequest(descriptor(), files, above, signal());
    await aboveProjection.prepare();
    expect(aboveProjection.omittedCount).toBe(1);
    const withText = buildResponsesRequest(descriptor(), request([{ role: "user", content: [
      { type: "text", text: "x".repeat(1_000) }, imageBlock(1_000), imageBlock(1_000),
    ] }]));
    const projection = new DeepSeekImageRequest(descriptor(), files, withText, signal(), undefined,
      { ...DEEPSEEK_IMAGE_LIMITS, bodyBytes: 3_000 });
    await projection.prepare();
    expect(projection.omittedCount).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(withText))).toBeLessThanOrEqual(3_000);
  });

  test("wire trace gives the recovered physical request its own payload and error record", async () => {
    const root = await directory();
    const trace = configureRuntimeWireTracing({ projectRoot: root, environment: { LOCAL_LOGS_ENABLED: "true" } })
      .startTurn("session", "turn").startProviderAttempt({ step: 0, attempt: 1, provider: "deepseek", model: "deepseek-flash", endpoint: "https://example.invalid/responses", timeoutMs: 1_000 })!;
    trace.requestStart({}, { input: [{ type: "input_image", file_id: "file-old" }] });
    trace.end(false, "file-old expired");
    const retry = trace.nextRequest!();
    retry.requestStart({}, { input: [{ type: "input_image", file_id: "file-new" }] });
    retry.end(true);
    const files = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true }));
    expect(files).toHaveLength(2);
    const bodies = await Promise.all(files.map(path => readFile(path, "utf8")));
    expect(bodies.some(body => body.includes("file-old expired") && body.includes('"request_index":1'))).toBe(true);
    expect(bodies.some(body => body.includes("file-new") && body.includes('"request_index":2'))).toBe(true);
  });
});
