import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { saihuNativeFetch } from "../../src/tooling/saihu-native-http";
import { OfficialMcpConnector, loadMcpConfig } from "../../src/tooling/mcp";

test("native fetch omits secrets, cookies, proxies and redirects while retaining real errors", async () => {
  const calls: Headers[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls.push(new Headers(request.headers));
    return new Response("actual upstream redirect", { status: 307, headers: { Location: "/elsewhere", "Set-Cookie": "private=value" } });
  } });
  const url = `http://127.0.0.1:${server.port}/mcp/`;
  try {
    // A fresh Bun process sees the proxy environment before fetch initializes.
    const modulePath = join(process.cwd(), "packages/agent/runtime/src/tooling/saihu-native-http.ts");
    const script = `import { saihuNativeFetch } from ${JSON.stringify(modulePath)};
      const request = saihuNativeFetch(${JSON.stringify(url)});
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
    await expect(saihuNativeFetch(url)(url + "other")).rejects.toThrow("target changed");
  } finally { server.stop(true); }
});

test("actual MCP SDK initializes, lists and calls without tokens, then preserves next-request denial", async () => {
  const calls: string[] = []; let denied = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("x-lxe-client")).toBe("cli");
    expect(request.headers.get("authorization")).toBeNull(); expect(request.headers.get("cookie")).toBeNull();
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as any; calls.push(message.method);
    if (denied) return Response.json({ detail: { code: "business_capability_denied", message: "actual sai hu denial" } }, { status: 403 });
    if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "fixture_read", description: "fixture", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "actual fixture result" }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  const root = mkdtempSync(join(tmpdir(), "lxe-native-mcp-"));
  let connection;
  try {
    const path = join(root, "mcp.yaml");
    writeFileSync(path, `mcpServers:\n  lxe-saihu:\n    enabled: true\n    type: streamable-http\n    url: http://127.0.0.1:${server.port}/mcp/\n    headers: {X-LXE-Client: cli}\n`);
    const config = loadMcpConfig(path, {}).servers[0]!;
    connection = await new OfficialMcpConnector({}).connect(config);
    expect(connection.tools.map(t => t.name)).toEqual(["fixture_read"]);
    expect((await connection.callTool("fixture_read", {})).content[0]?.text).toBe("actual fixture result");
    denied = true;
    await expect(connection.callTool("fixture_read", {})).rejects.toThrow("actual sai hu denial");
    expect(calls.filter(method => method === "tools/call")).toHaveLength(2);
  } finally { await connection?.close(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("native fetch cancellation closes a pending stream", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  const url = `http://127.0.0.1:${server.port}/mcp/`;
  try {
    const controller = new AbortController();
    const pending = saihuNativeFetch(url)(url, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
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
    const response = await saihuNativeFetch(url)(url, { signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: first");
    const next = reader.read(); abort.abort();
    // Bun 1.4.2 on Windows crashes when the async rejects matcher owns this stream error.
    // Await and assert the same rejection explicitly; do not skip cancellation coverage.
    let rejection: unknown;
    try { await next; } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    mode = "error";
    const error = await saihuNativeFetch(url)(url);
    expect(error.status).toBe(502); expect(await error.text()).toBe("actual compressed failure");
    expect(error.headers.get("content-encoding")).toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
