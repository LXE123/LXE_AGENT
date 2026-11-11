import { expect, test } from "bun:test";
import { createLogger } from "@lxe/core";
import { fileURLToPath } from "node:url";
import { createHarnessFetch } from "../../src/network/fetch";

const logger = createLogger("network-test", { write: () => {} });
const systemProxy = async () => ({ http: "http://manual:8080", https: "http://manual:8080", bypass: ["*.internal"] });
const proxy = (init?: RequestInit) => (init as RequestInit & { proxy: string | false }).proxy;

test("system proxy routes a real HTTP request without resolving its target locally", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    seen.push(req.url);
    expect(await req.text()).toBe("payload");
    return new Response("proxy reached");
  } });
  try {
    const fetch = createHarnessFetch({ environment: {}, logger,
      systemProxy: async () => ({ http: server.url.origin, bypass: [] }) });
    const response = await fetch("http://does-not-resolve.invalid/test", { method: "POST", body: "payload" });
    expect(await response.text()).toBe("proxy reached");
    expect(seen).toEqual(["http://does-not-resolve.invalid/test"]);
  } finally { server.stop(true); }
});

test("environment wins without querying OS settings; direct local calls also skip the query", async () => {
  const fetch = createHarnessFetch({ environment: { HTTPS_PROXY: "http://explicit:9090" }, logger,
    systemProxy: async () => { throw new Error("must not read system settings"); },
    fetch: async (input, init) => Response.json({ url: String(input), proxy: proxy(init) }) });
  expect(await (await fetch("https://api.example.com")).json()).toEqual({ url: "https://api.example.com/", proxy: "http://explicit:9090/" });
  expect((await (await fetch("http://127.0.0.1:1234/callback")).json() as { proxy: unknown }).proxy).toBe(false);
});

test("actual direct transport ignores inherited proxies even when NO_PROXY is empty", async () => {
  let proxyCalls = 0;
  const proxyServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { proxyCalls++; return new Response("wrong proxy"); } });
  const direct = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("direct") });
  try {
    const module = fileURLToPath(new URL("../../src/network/fetch.ts", import.meta.url));
    const source = `import { harnessFetch } from ${JSON.stringify(module)};
      console.log(await (await harnessFetch(${JSON.stringify(direct.url.href)}, { signal: AbortSignal.timeout(2000) })).text());`;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", env: {
      ...process.env, HTTP_PROXY: proxyServer.url.origin, http_proxy: proxyServer.url.origin,
      HTTPS_PROXY: proxyServer.url.origin, https_proxy: proxyServer.url.origin, ALL_PROXY: proxyServer.url.origin,
      all_proxy: proxyServer.url.origin, NO_PROXY: "", no_proxy: "",
    } });
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(output.trim().split("\n").at(-1)).toBe("direct");
    expect(proxyCalls).toBe(0);
  } finally { proxyServer.stop(true); direct.stop(true); }
});

test("redirects select the new route, strip cross-origin credentials and convert POST to GET", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = createHarnessFetch({ environment: {}, systemProxy, logger, fetch: async (input, init) => {
    requests.push({ url: String(input), init: init! });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: "http://service.internal/next" } }) : new Response("done");
  } });
  const response = await fetch("https://public.example.com", { method: "POST", body: "secret body",
    headers: { authorization: "Bearer test", "x-api-key": "key", cookie: "session=test", "content-type": "text/plain" } });
  expect(proxy(requests[0]!.init)).toBe("http://manual:8080");
  expect(proxy(requests[1]!.init)).toBe(false);
  expect(requests[1]!.init.method).toBe("GET");
  expect(requests[1]!.init.body).toBeUndefined();
  expect([...new Headers(requests[1]!.init.headers)]).toEqual([]);
  expect(response.redirected).toBe(true);
});

test("307 preserves replayable body and same-origin headers; manual mode is left alone", async () => {
  let calls = 0;
  const fetch = createHarnessFetch({ environment: {}, systemProxy, logger, fetch: async (_input, init) => {
    calls++;
    expect(init?.body).toBe("payload");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
    return calls % 2 === 1 ? new Response(null, { status: 307, headers: { location: "/next" } }) : new Response("ok");
  } });
  const request = { method: "POST", body: "payload", headers: { authorization: "Bearer fixture" } };
  expect(await (await fetch("https://api.example.com", request)).text()).toBe("ok");
  expect((await fetch("https://api.example.com", { ...request, redirect: "manual" })).status).toBe(307);
  expect(calls).toBe(3);
});

test("OAuth redirect:error and request cancellation remain effective with native fetch", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "/next" } }) });
  try {
    const fetch = createHarnessFetch({ environment: {}, systemProxy, logger });
    await expect(fetch(server.url, { redirect: "error" })).rejects.toThrow();
    const cancel = new AbortController();
    const original = new Error("user cancelled"); cancel.abort(original);
    await expect(fetch(server.url, { signal: cancel.signal })).rejects.toBe(original);
  } finally { server.stop(true); }
});

test("direct SSE delivers partial output and can be cancelled while reading", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
  }), { headers: { "content-type": "text/event-stream" } }) });
  try {
    const fetch = createHarnessFetch({ environment: {}, systemProxy, logger });
    const cancel = new AbortController();
    const response = await fetch(server.url, { signal: cancel.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    cancel.abort(new Error("cancel streaming response"));
    await expect(reader.read()).rejects.toThrow("cancel streaming response");
  } finally { server.stop(true); }
});

test("redirect loops are bounded and request bodies are not replayed after streaming", async () => {
  let calls = 0;
  const fetch = createHarnessFetch({ environment: {}, systemProxy, logger, fetch: async () => {
    calls++; return new Response(null, { status: 307, headers: { location: "/next" } });
  } });
  await expect(fetch("https://api.example.com")).rejects.toThrow("HTTP redirect limit exceeded");
  expect(calls).toBe(21);
  await expect(fetch(new Request("https://api.example.com", { method: "POST", body: "body" })))
    .rejects.toThrow("Cannot replay a streaming request body");
});

test("cancellation while reading settings does not wait for the shared query", async () => {
  const deferred = Promise.withResolvers<{ bypass: string[] }>();
  const fetch = createHarnessFetch({ environment: {}, logger, systemProxy: () => deferred.promise,
    fetch: async () => { throw new Error("must not send cancelled request"); } });
  const cancel = new AbortController();
  const request = fetch("https://api.example.com", { signal: cancel.signal });
  const reason = new Error("stopped while reading proxy"); cancel.abort(reason);
  await expect(request).rejects.toBe(reason);
  deferred.resolve({ bypass: [] });
});

test("transport failures keep the actual error and do not silently retry direct", async () => {
  let calls = 0;
  const reason = Object.assign(new Error("proxy socket closed"), { code: "ECONNRESET" });
  const fetch = createHarnessFetch({ environment: {}, systemProxy, logger, fetch: async () => { calls++; throw reason; } });
  await expect(fetch("https://api.example.com")).rejects.toBe(reason);
  expect(calls).toBe(1);
});

test("proxy read errors stay visible; route logs omit proxy credentials and URL secrets", async () => {
  const failure = new Error("scutil exited with code 1");
  const broken = createHarnessFetch({ environment: {}, logger, systemProxy: async () => { throw failure; } });
  await expect(broken("https://api.example.com")).rejects.toBe(failure);
  const lines: string[] = [];
  const fetch = createHarnessFetch({ environment: { HTTPS_PROXY: "http://alice:password@proxy.example:8080" },
    logger: createLogger("route-test", { write: line => lines.push(line) }), fetch: async () => new Response("ok") });
  await fetch("https://api.example.com/private?token=secret");
  expect(lines.join()).toContain("http://proxy.example:8080");
  for (const value of ["alice", "password", "private", "secret"]) expect(lines.join()).not.toContain(value);
});
