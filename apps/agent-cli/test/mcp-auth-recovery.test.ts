import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type McpServerConfig } from "@lxe/runtime";
import { McpAccess } from "../src/mcp-access";
import { McpAuthStore } from "../src/mcp-auth-store";
import { openMcpCliBridge } from "../src/mcp-cli-bridge";
import { legacyReply, type WireMessage } from "../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture";
import { policyFor, testWorkspace } from "../../../packages/agent/runtime/test/workspace";

type Failure = "no-refresh" | "invalid-grant" | "reject-renewed" | "refresh-unavailable" | "tool-500" | "business-error" | "refresh-ok";

async function fixture(failure: Failure) {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-recovery-"));
  let accepted = "access-1", broken = false, refreshes = 0, browsers = 0, calls = 0, handshakes = 0;
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const { origin, pathname } = new URL(req.url);
    if (pathname === "/resource") return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
    if (pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin,
      authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    if (pathname === "/register") return Response.json({ ...await req.json() as object, client_id: "fixture" }, { status: 201 });
    if (pathname === "/token") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        if (failure === "invalid-grant") return Response.json({ error: "invalid_grant", error_description: "fixture refresh-1 revoked" }, { status: 400 });
        if (failure === "refresh-unavailable") return new Response("fixture issuer unavailable", { status: 503 });
        if (failure !== "reject-renewed") accepted = "access-2";
        return Response.json({ access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer" });
      }
      accepted = "signed-in";
      broken = false;
      return Response.json({ access_token: accepted, token_type: "Bearer" });
    }
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const message = await req.json() as WireMessage;
    if (message.method === "initialize") handshakes++;
    if (message.method === "tools/call") {
      calls++;
      if (broken && failure === "tool-500") return new Response("fixture upstream failed", { status: 500 });
      if (broken && failure === "business-error") return Response.json({ jsonrpc: "2.0", id: message.id,
        result: { isError: true, content: [{ type: "text", text: "fixture order not found" }] } });
    }
    if (req.headers.get("authorization") !== "Bearer " + accepted) return new Response("fixture access denied", {
      status: 401, headers: { "WWW-Authenticate": `Bearer error="invalid_token", scope="orders.read", resource_metadata="${origin}/resource"` },
    });
    const reply = legacyReply(message);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  } });
  const url = http.url.origin + "/mcp";
  const server: McpServerConfig = {
    name: "orders", enabled: true, transport: "streamable-http", command: "", args: [], env: {}, cwd: "", url,
    headers: {}, envHeaders: {}, bearerTokenEnvVar: "", connectorId: "orders", connectorName: "Orders", connectorDescription: "",
    protocolMode: "legacy", startupTimeoutMs: 3000, toolTimeoutMs: 3000, enabledTools: new Set(), disabledTools: new Set(), exposure: "codemode",
  };
  const store = new McpAuthStore(root);
  await store.save({ name: server.name, url, access_token: "access-1", ...(failure !== "no-refresh" && { renewal: {
    refresh_token: "refresh-1", issuer: http.url.origin, client: { client_id: "fixture" },
  } }) });
  const registry = new ToolRegistry();
  const access = new McpAccess({ servers: [server] }, store, {}, async link => {
    browsers++;
    const auth = new URL(link);
    expect(auth.searchParams.get("scope")).toBe("orders.read");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "approved");
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    expect((await fetch(callback)).ok).toBe(true);
  });
  const bridge = await openMcpCliBridge({
    list: async () => { const state = access.manager.status(server.name); return [{ name: server.name, status: state.state,
      transport: server.transport, tool_count: state.toolCount, error: state.error, tools: state.tools }]; },
    login: (name, signal, _session, progress) => access.login(name, signal, progress),
    logout: name => access.logout(name),
  });
  await access.manager.start(registry);
  const call = () => registry.execute("mcp__orders__echo", {}, {
    session_id: "audit", workspace: testWorkspace, executionPolicy: policyFor(testWorkspace.directory),
    handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} },
    exposureState: registry.createExposureState().forCodemode(),
  });
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp", ...args], {
      env: { ...process.env, ...bridge.environment, LXE_MCP_CLI_SESSION_ID: "audit" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }
  return { access, registry, call, cli, counts: () => ({ browsers, refreshes, calls, handshakes }),
    breakAuthorization: () => { broken = true; if (!["tool-500", "business-error"].includes(failure)) accepted = "revoked"; },
    async close() { await bridge.close(); access.stop(); await access.manager.stop(); http.stop(true); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const failure of ["no-refresh", "invalid-grant", "reject-renewed"] as const) {
  test(`tool authorization failure (${failure}) updates chat list and permits login without logout`, async () => {
    const f = await fixture(failure);
    try {
      await f.call();
      f.breakAuthorization();
      const diagnostic = failure === "invalid-grant" ? "invalid_grant" : "fixture access denied";
      await expect(f.call()).rejects.toThrow(diagnostic);
      expect(f.access.manager.status("orders")).toMatchObject({ state: "needs_auth", connected: false, tools: [], error: expect.stringContaining(diagnostic) });
      expect(f.registry.definition("mcp__orders__echo")).toBeUndefined();
      expect(f.counts().browsers).toBe(0);
      const list = await f.cli("list");
      expect(list.code, list.err).toBe(1);
      expect(list.out).toContain("orders: needs_auth");
      expect(list.out).toContain("agent-cli mcp login orders");
      expect(list.out).toContain(diagnostic);
      expect(list.out).not.toContain("refresh-1");
      const before = f.counts();
      for (let step = 0; step < 3; step++) expect(await f.access.reconnectAfterExternalAuthChange()).toBe(false);
      expect(f.counts()).toEqual(before);
      const login = await f.cli("login", "orders");
      expect(login.code, login.err).toBe(0);
      expect(login.out).toContain('Sign in to MCP server "orders" in your browser:');
      expect(login.out).toContain('Connected to MCP server "orders"');
      expect(login.out).not.toContain("already connected");
      expect(f.counts().browsers).toBe(1);
      expect(f.access.manager.status("orders")).toMatchObject({ state: "ready", error: "" });
      expect(await f.cli("list")).toMatchObject({ code: 0, out: expect.stringContaining("orders: ready") });
      await f.call();
    } finally { await f.close(); }
  });
}

for (const failure of ["refresh-unavailable", "tool-500", "business-error", "refresh-ok"] as const) {
  test(`${failure} does not incorrectly mark the MCP connection as needing login`, async () => {
    const f = await fixture(failure);
    try {
      f.breakAuthorization();
      if (failure === "refresh-ok") await f.call();
      else if (failure === "business-error") {
        // Codemode receives the complete MCP result, including business errors.
        expect(await f.call()).toMatchObject({ isError: true });
      } else await expect(f.call()).rejects.toThrow(failure === "tool-500" ? "fixture upstream failed" : "fixture issuer unavailable");
      expect(f.access.manager.status("orders").state).toBe("ready");
      expect(f.registry.definition("mcp__orders__echo")).toBeDefined();
      expect(f.counts().browsers).toBe(0);
      expect(f.counts().calls).toBe(failure === "refresh-ok" ? 2 : 1);
      expect(f.counts().refreshes).toBe(["refresh-ok", "refresh-unavailable"].includes(failure) ? 1 : 0);
    } finally { await f.close(); }
  });
}
