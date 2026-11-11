import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type McpConfig, type McpServerConfig } from "@lxe/runtime";
import { McpAccess } from "../src/mcp-access";
import { McpAuthStore } from "../src/mcp-auth-store";
import { openMcpCliBridge } from "../src/mcp-cli-bridge";
import { legacyReply, type WireMessage } from "../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture";

const serverConfig = (url: string): McpServerConfig => ({
  name: "team-skills", enabled: true, transport: "streamable-http", protocolMode: "auto", url,
  command: "", args: [], env: {}, cwd: "", headers: {}, envHeaders: {}, bearerTokenEnvVar: "",
  connectorId: "", connectorName: "", connectorDescription: "", startupTimeoutMs: 1_000,
  toolTimeoutMs: 1_000, enabledTools: new Set(), disabledTools: new Set(), exposure: "codemode",
});

async function bridgeFor(access: McpAccess, config: McpConfig) {
  return openMcpCliBridge({
    list: async () => config.servers.map(({ name, transport }) => {
      const { state: status, toolCount: tool_count, error, tools } = access.manager.status(name);
      return { name, transport, status, tool_count, error, tools };
    }),
    login: (name, signal, _sessionId, onProgress) => access.login(name, signal, onProgress),
    logout: name => access.logout(name),
  });
}

async function cli(root: string, environment: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp", ...args], {
    cwd: root,
    env: { ...process.env, LXE_DATA_ROOT: root, LXE_MCP_CONFIG_PATH: join(root, "config/mcp_servers.local.json"),
      LXE_MCP_CLI_PIPE: "", LXE_MCP_CLI_TOKEN: "", LXE_MCP_CLI_SESSION_ID: "test-chat", ...environment },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

function writeConfig(root: string, url: string) {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/mcp_servers.local.json"), JSON.stringify({ servers: {
    "team-skills": { enabled: true, transport: "streamable-http", url, startup_timeout_s: 1 },
  } }));
}

test("list probes fresh HTTP connections from both chat and terminal despite a previous chat failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-list-fresh-"));
  let response: "error" | "ready" | "needs_auth" = "error", handshakes = 0, discoveries = 0;
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (response === "error") return new Response("fixture upstream unavailable", { status: 503 });
    if (response === "needs_auth") return new Response("fixture sign-in required", { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as WireMessage;
    if (message.method === "initialize") handshakes++;
    if (message.method === "tools/list") discoveries++;
    const reply = legacyReply(message);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  } });
  writeConfig(root, http.url.href);
  const config = { servers: [serverConfig(http.url.href)] };
  const access = new McpAccess(config, new McpAuthStore(root), {}, async () => { throw new Error("list must not open a browser"); });
  const bridge = await bridgeFor(access, config);
  try {
    await access.manager.start(new ToolRegistry());
    const original = access.manager.status("team-skills");
    expect(original.state).toBe("error");
    response = "ready";
    // The command ignores host pipe metadata, even when it is incomplete or stale.
    for (const environment of [bridge.environment, {}, { LXE_MCP_CLI_PIPE: "missing-pipe", LXE_MCP_CLI_TOKEN: "", LXE_MCP_CLI_SESSION_ID: "" }]) {
      const before = handshakes;
      const result = await cli(root, environment, "list", "--json");
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.out)).toEqual([expect.objectContaining({ name: "team-skills", status: "ready", tool_count: 2, error: "" })]);
      expect(handshakes).toBe(before + 1);
      expect(access.manager.status("team-skills")).toEqual(original);
    }
    expect(discoveries).toBe(6); // Each temporary connection discovers both tool pages.
    for (const environment of [bridge.environment, {}]) {
      response = "needs_auth";
      const auth = await cli(root, environment, "list");
      expect(auth.code, auth.err).toBe(1);
      expect(auth.out).toContain("team-skills: needs_auth");
      expect(auth.out).toContain("Sign in with: agent-cli mcp login team-skills");
      response = "error";
      const failure = await cli(root, environment, "list");
      expect(failure.code, failure.err).toBe(1);
      expect(failure.out).toContain("fixture upstream unavailable");
      expect(failure.out).not.toContain("Sign in with:");
    }
    expect(access.manager.status("team-skills")).toEqual(original);
  } finally { await bridge.close(); access.stop(); await access.manager.stop(); http.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("chat and terminal commands report a real connection failure without claiming browser sign-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-command-failure-"));
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("fixture upstream unavailable; token=fixture-secret", { status: 503 }) });
  const config = { servers: [serverConfig(http.url.href)] };
  writeConfig(root, http.url.href);
  let browserOpens = 0;
  const access = new McpAccess(config, new McpAuthStore(root), {}, async () => { browserOpens++; });
  const bridge = await bridgeFor(access, config);
  try {
    await access.manager.start(new ToolRegistry());
    const list = await cli(root, bridge.environment, "list");
    expect(list.code).toBe(1);
    expect(list.out).toStartWith("team-skills: error (streamable-http)\n  Error:");
    expect(list.out).toContain("fixture upstream unavailable");
    expect(list.out).not.toContain("0 tools");
    expect(list.out).not.toContain("Sign in with:");
    const json = await cli(root, bridge.environment, "list", "--json");
    expect(JSON.parse(json.out)[0]).toMatchObject({ name: "team-skills", status: "error", tool_count: 0 });
    for (const environment of [bridge.environment, {}]) {
      const result = await cli(root, environment, "login", "team-skills");
      expect(result.code).toBe(1);
      expect(result.out).toBe('Checking connection to MCP server "team-skills".\n');
      expect(result.err).toContain('MCP server "team-skills" failed to connect:');
      expect(result.err).toContain("fixture upstream unavailable");
      expect(result.err).toContain("503");
      expect(result.err).toContain("[redacted]");
      expect(result.err).not.toContain("fixture-secret");
    }
    expect(browserOpens).toBe(0);
  } finally { await bridge.close(); await access.manager.stop(); await http.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

for (const failure of ["denied", "save", "browser"] as const) {
  test(`chat login identifies ${failure === "denied" ? "authorization denial" : failure === "save" ? "credential saving failure" : "browser launcher failure"} and retains the actual error`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-login-failure-"));
    let browserOpens = 0;
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const { pathname, origin } = new URL(request.url);
      if (pathname === "/resource") return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
      if (pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin,
        authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      if (pathname === "/register") return Response.json({ ...await request.json() as Record<string, unknown>, client_id: "fixture" }, { status: 201 });
      if (pathname === "/token") return Response.json({ access_token: "fixture-token", token_type: "Bearer" });
      return new Response("Sign in first", { status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/resource"` } });
    } });
    const config = { servers: [serverConfig(http.url.origin + "/mcp")] };
    writeConfig(root, http.url.origin + "/mcp");
    const access = new McpAccess(config, new McpAuthStore(root), {}, async url => {
      browserOpens++;
      if (failure === "browser") throw new Error("fixture browser launcher unavailable");
      const auth = new URL(url), callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set(failure === "denied" ? "error" : "code", failure === "denied" ? "access_denied" : "approved");
      // A real filesystem error after authorization, rather than a fabricated user-facing diagnostic.
      if (failure === "save") mkdirSync(join(root, "config/mcp-auth.json"), { recursive: true });
      expect((await fetch(callback)).status).toBe(failure === "denied" ? 400 : 200);
    });
    const bridge = await bridgeFor(access, config);
    try {
      await access.manager.start(new ToolRegistry());
      const list = await cli(root, bridge.environment, "list");
      expect(list.out).toContain("team-skills: needs_auth (streamable-http)");
      expect(list.out).toContain("Sign in with: agent-cli mcp login team-skills");
      const result = await cli(root, bridge.environment, "login", "team-skills");
      expect(result.code).toBe(1);
      expect(result.out).toStartWith('Checking connection to MCP server "team-skills".\nSign in to MCP server "team-skills" in your browser:\n');
      expect(result.out).toContain(http.url.origin + "/authorize?");
      expect(result.out).not.toContain("were saved");
      expect(result.err).toContain(failure === "denied"
        ? 'MCP server "team-skills" sign-in failed:\nMCP OAuth callback error: access_denied'
        : failure === "save" ? 'MCP server "team-skills" failed to save OAuth credentials:'
        : 'MCP server "team-skills" sign-in failed:\nfixture browser launcher unavailable');
      if (failure === "save") expect(result.err).toContain("EISDIR");
      expect(result.err).not.toContain("credentials were saved");
      expect(result.err).not.toContain("fixture-token");
      expect(browserOpens).toBe(1);
    } finally { await bridge.close(); await access.manager.stop(); await http.stop(true); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["chat", "terminal"] as const) {
  test(`${mode} login streams the authorization URL before approval, then reports saved credentials and connection`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-login-progress-"));
    let exchanges = 0;
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const { pathname, origin } = new URL(request.url);
      if (pathname === "/resource") return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
      if (pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin,
        authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      if (pathname === "/register") return Response.json({ ...await request.json() as Record<string, unknown>, client_id: "fixture" }, { status: 201 });
      if (pathname === "/token") { exchanges++; return Response.json({ access_token: "fixture-private-token", token_type: "Bearer" }); }
      if (request.headers.get("Authorization") !== "Bearer fixture-private-token") return new Response("Sign in first", { status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/resource"` } });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const reply = legacyReply(await request.json() as WireMessage);
      return reply ? Response.json(reply) : new Response(null, { status: 202 });
    } });
    const config = { servers: [serverConfig(http.url.origin + "/mcp")] };
    const store = new McpAuthStore(root);
    const access = new McpAccess(config, store, {}, async () => {});
    const bridge = await bridgeFor(access, config);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config/mcp_servers.local.json"), JSON.stringify({ servers: {
      "team-skills": { url: http.url.origin + "/mcp", transport: "streamable-http", enabled: true },
    } }));
    // Replace only the OS browser launcher; exercise the actual command, SDK and OAuth callback.
    const runner = join(root, "command.ts");
    writeFileSync(runner, `import { runMcpCommand } from ${JSON.stringify(join(import.meta.dir, "../src/mcp-command.ts"))};
      console.log = (...values) => { process.stderr.write(values.map(String).join(" ") + "\\n"); };
      process.exitCode = await runMcpCommand(["login", "team-skills"], async () => {});`);
    await access.manager.start(new ToolRegistry());
    const child = Bun.spawn([process.execPath, runner], { cwd: root,
      env: { ...process.env, LOCAL_LOGS_ENABLED: "0", LXE_DATA_ROOT: root,
        LXE_MCP_CONFIG_PATH: join(root, "config/mcp_servers.local.json"), LXE_MCP_CLI_PIPE: "", LXE_MCP_CLI_TOKEN: "",
        LXE_MCP_CLI_SESSION_ID: "test-chat", ...(mode === "chat" ? bridge.environment : {}) }, stdout: "pipe", stderr: "pipe" });
    let output = "";
    const advertised = Promise.withResolvers<URL>();
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk, { stream: true });
        const link = output.split("\n").find(line => line.startsWith(http.url.origin + "/authorize?"));
        if (link && output.includes(link + "\n")) advertised.resolve(new URL(link));
      }
      advertised.reject(new Error("Command exited before reporting an authorization URL"));
    })();
    const stderr = new Response(child.stderr).text();
    try {
      const url = await advertised.promise;
      expect(child.exitCode).toBeNull();
      expect(exchanges).toBe(0);
      expect(store.get("team-skills", config.servers[0]!.url)).toBeUndefined();
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-private-code");
      expect((await fetch(callback)).status).toBe(200);
      const [code, error] = await Promise.all([child.exited, stderr, reading]);
      expect(code, error).toBe(0);
      expect(exchanges).toBe(1);
      expect(output).toContain('OAuth credentials for MCP server "team-skills" were saved. Verifying the connection.\nConnected to MCP server "team-skills".');
      expect(output).not.toContain("fixture-private-token");
      expect(output).not.toContain("fixture-private-code");
      if (mode === "chat") expect(access.manager.status("team-skills")).toMatchObject({ connected: true, toolCount: 2 });
      const reuse = await cli(root, mode === "chat" ? bridge.environment : {}, "login", "team-skills");
      expect(reuse.code, reuse.err).toBe(0);
      expect(reuse.out).toContain("already connected");
      expect(reuse.out).not.toContain("in your browser");
      expect(exchanges).toBe(1);
    } finally {
      child.kill(); await child.exited; await reading; await stderr;
      await bridge.close(); await access.manager.stop(); await http.stop(true); rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}
