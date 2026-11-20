import { expect, test } from "bun:test";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { nativeCloudFetch } from "../../src/tooling/cloud-http";

test("native fetch omits secrets, cookies, proxies and redirects while retaining real errors", async () => {
  const calls: Headers[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls.push(new Headers(request.headers));
    return new Response("actual upstream redirect", { status: 307, headers: { Location: "/elsewhere", "Set-Cookie": "private=value" } });
  } });
  const url = `http://127.0.0.1:${server.port}/mcp/`;
  try {
    // A fresh Bun process sees the proxy environment before fetch initializes.
    const modulePath = join(process.cwd(), "packages/agent/runtime/src/tooling/cloud-http.ts");
    const script = `import { nativeCloudFetch } from ${JSON.stringify(modulePath)};
      const request = nativeCloudFetch(${JSON.stringify(url)});
      for (let i=0;i<2;i++) { const r=await request(${JSON.stringify(url)}, {headers:{Authorization:'Bearer secret',Cookie:'private=value','Mcp-Session-Id':'session'}});
        if(r.status!==307 || await r.text()!=='actual upstream redirect') process.exit(1); }`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env,
      HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "" }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
    expect(calls).toHaveLength(2);
    for (const headers of calls) {
      expect(headers.get("authorization")).toBeNull(); expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-lxe-client")).toBe("cli"); expect(headers.get("mcp-session-id")).toBe("session");
    }
    await expect(nativeCloudFetch(url)(url + "other")).rejects.toThrow("target changed");
  } finally { server.stop(true); }
});

test("native fetch cancellation closes a pending stream", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const url = `http://127.0.0.1:${server.port}/mcp/`;
  try {
    const controller = new AbortController();
    const pending = nativeCloudFetch(url)(url, { signal: controller.signal });
    controller.abort();
    let cancelled: unknown;
    try { await pending; } catch (error) { cancelled = error; }
    expect(cancelled).toBeInstanceOf(Error);
  } finally { server.stop(true); }
});

test("direct transport streams SSE, decodes compressed errors and cancels an active body", async () => {
  let mode = "sse";
  // Use a direct HTTP fixture for a deliberately unfinished response body.
  const server = createServer((_request, response) => {
    if (mode === "error") {
      response.writeHead(502, { "Content-Encoding": "gzip" });
      response.end(gzipSync("actual compressed failure"));
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: message\ndata: first\n\n");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/`;
  try {
    const abort = new AbortController();
    const response = await nativeCloudFetch(url)(url, { signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: first");
    const next = reader.read(); abort.abort();
    // Bun 1.4.2 on Windows crashes when the async rejects matcher owns this stream error.
    // Await and assert the same rejection explicitly; do not skip cancellation coverage.
    let rejection: unknown;
    try { await next; } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    mode = "error";
    const error = await nativeCloudFetch(url)(url);
    expect(error.status).toBe(502); expect(await error.text()).toBe("actual compressed failure");
    expect(error.headers.get("content-encoding")).toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
