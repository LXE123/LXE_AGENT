import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseMcpCommand, requireMcpServer } from "../src/mcp-command-args";

test("MCP arguments distinguish bad commands, missing names, options and transport-specific inputs", () => {
  const cases: Array<[string[], string]> = [
    [["logni", "docs"], 'Unknown MCP command "logni"'],
    [["login"], "Missing MCP server name"],
    [["login", "--timeout", "30"], "Missing MCP server name"],
    [["login", "bad/name"], 'Invalid MCP server name "bad/name"'],
    [["list", "--unknown"], "Unknown option '--unknown'"],
    [["list", "docs"], "Unexpected argument 'docs'"],
    [["logout", "docs", "--unknown"], "Unknown option '--unknown'"],
    [["remove", "docs", "extra"], "Unexpected argument 'extra'"],
    [["login", "docs", "--timeout"], "argument missing"],
    [["login", "docs", "--timeout", "0"], "--timeout must be a positive number of seconds"],
    [["add", "docs"], "Specify --url"],
    [["add", "docs", "--url", "invalid"], "--url must be a valid HTTP or HTTPS URL"],
    [["add", "docs", "--url", "https://example.com/mcp", "--cwd", "."], "--cwd only applies to stdio"],
    [["add", "docs", "--header", "X-Test=test", "--", "node"], "--header only applies to HTTP"],
    [["add", "docs", "--"], "Missing executable after --"],
    [["add", "docs", "--exposure", "typo", "--", "node"], "--exposure must be"],
    [["add", "docs", "--env", "TOKEN", "--", "node"], "Expected --env KEY=VALUE"],
  ];
  for (const [args, error] of cases) expect(() => parseMcpCommand(args), args.join(" ")).toThrow(error);
  expect(parseMcpCommand(["add", "docs", "--", "node", "--help"])).toMatchObject({ kind: "add", definition: { command: "node", args: ["--help"] } });
  expect(parseMcpCommand(["list", "--json"])).toEqual({ kind: "list", json: true });
  expect(parseMcpCommand(["login", "docs", "--timeout", "600"])).toMatchObject({ timeout: 600_000 });
  expect(parseMcpCommand(["login", "docs", "--timeout", "0.5"])).toMatchObject({ timeout: 500 });
  for (const value of ["NaN", "Infinity", "-1"]) expect(() => parseMcpCommand(["login", "docs", "--timeout", value])).toThrow();
  expect(parseMcpCommand(["add", "docs", "--url", "https://example.com/mcp", "--oauth-client-id", "client", "--oauth-client-secret", "${CLIENT_SECRET}",
    "--oauth-callback-port", "8765", "--oauth-client-name", "My agent", "--oauth-client-registration", "dcr"])).toMatchObject({ definition: {
    oauth: { clientId: "client", clientSecret: "${CLIENT_SECRET}", callbackPort: 8765, clientName: "My agent", clientRegistration: "dcr" },
  } });
});

test("unknown server hints use configured names without silently changing the requested target", () => {
  const servers = [{ name: "team-skills" }, { name: "lxe_desktop" }];
  for (const name of ["team_skills", "mcp__team_skills"]) {
    expect(() => requireMcpServer(name, servers)).toThrow('Did you mean "team-skills"?');
  }
  expect(() => requireMcpServer("missing", servers)).toThrow("Configured servers: team-skills, lxe_desktop.");
  expect(() => requireMcpServer("missing", [])).toThrow("No MCP servers configured.");
});

test("MCP help and invalid arguments finish before opening configuration or connecting to a server", async () => {
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp", ...args], {
      // Help and argument parsing must not read this invalid configuration path.
      env: { ...process.env, LXE_MCP_CONFIG_PATH: "/not-a-config-file" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }
  for (const args of [[], ["help"], ["--help"], ["help", "login"], ["list", "--help"], ["login", "--help"], ["login", "docs", "--help"]]) {
    const result = await cli(args);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toStartWith("Usage: agent-cli mcp");
    expect(result.err).toBe("");
  }
  for (const args of [["unknown"], ["login"], ["list", "--unknown"], ["remove", "docs", "extra"]]) {
    const result = await cli(args);
    expect(result.code, result.err).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("Usage: agent-cli mcp");
    expect(result.err).not.toContain("Incomplete MCP management connection");
  }
}, 15_000);
