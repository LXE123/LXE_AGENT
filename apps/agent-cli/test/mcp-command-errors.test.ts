import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type McpConfig, type McpServerConfig } from "@lxe/runtime";
import { McpAccess } from "../src/mcp-access";
import { McpAuthStore } from "../src/mcp-auth-store";
import { openMcpCliBridge } from "../src/mcp-cli-bridge";

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
    login: (name, signal) => access.login(name, signal),
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

test("chat and terminal commands report a real connection failure without claiming browser sign-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-command-failure-"));
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("fixture upstream unavailable; token=fixture-secret", { status: 503 }) });
  const config = { servers: [serverConfig(http.url.href)] };
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
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config/mcp_servers.local.json"), JSON.stringify({ servers: {
      "team-skills": { enabled: true, transport: "streamable-http", url: http.url.href, startup_timeout_s: 1 },
    } }));
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

for (const failure of ["denied", "save"] as const) {
  test(`chat login identifies ${failure === "denied" ? "authorization denial" : "credential saving failure"} and retains the actual error`, async () => {
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
    const access = new McpAccess(config, new McpAuthStore(root), {}, async url => {
      browserOpens++;
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
      expect(result.out).toBe('Checking connection to MCP server "team-skills".\n');
      expect(result.err).toContain(failure === "denied"
        ? 'MCP server "team-skills" sign-in failed:\nMCP OAuth callback error: access_denied'
        : 'MCP server "team-skills" failed to save OAuth credentials:');
      if (failure === "save") expect(result.err).toContain("EISDIR");
      expect(result.err).not.toContain("credentials were saved");
      expect(result.err).not.toContain("fixture-token");
      expect(browserOpens).toBe(1);
    } finally { await bridge.close(); await access.manager.stop(); await http.stop(true); rmSync(root, { recursive: true, force: true }); }
  });
}
