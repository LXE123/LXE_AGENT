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
    [["login", "docs", "--timeout", "0"], "--timeout must be between 1 and 300 seconds"],
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
});

test("unknown server hints use configured names without silently changing the requested target", () => {
  const servers = [{ name: "team-skills" }, { name: "lxe_desktop" }];
  for (const name of ["team_skills", "mcp__team_skills"]) {
    expect(() => requireMcpServer(name, servers)).toThrow('Did you mean "team-skills"?');
  }
  expect(() => requireMcpServer("missing", servers)).toThrow("Configured servers: team-skills, lxe_desktop.");
  expect(() => requireMcpServer("missing", [])).toThrow("No MCP servers configured.");
});

test("MCP help and invalid arguments finish before opening configuration or contacting the Harness", async () => {
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp", ...args], {
      // Any accidental access would fail with an incomplete management connection.
      env: { ...process.env, LXE_MCP_CLI_PIPE: "not-a-pipe", LXE_MCP_CLI_TOKEN: "" }, stdout: "pipe", stderr: "pipe",
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
    expect(result.code, result.err).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("Usage: agent-cli mcp");
    expect(result.err).not.toContain("Incomplete MCP management connection");
  }
}, 15_000);
