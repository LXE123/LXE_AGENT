import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The Pi CLI has no LXE desktop session. Attach the test turn's caller metadata
// on its stdio pipe; the real desktop server still authenticates every call.
if (import.meta.main) {
  const [server, session, turn] = process.argv.slice(2);
  const child = spawn(process.execPath, [server!], { stdio: ["pipe", "inherit", "inherit"] });
  let sequence = 0;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "tools/call") {
      message.params._meta = { ...message.params._meta, "lxe.desktop/caller": {
        platform: "desktop", session_id: session, turn_id: turn, tool_call_id: `pi-reference-${++sequence}`,
      } };
    }
    child.stdin.write(JSON.stringify(message) + "\n");
  });
  lines.on("close", () => child.stdin.end());
  child.on("exit", code => process.exit(code ?? 1));
}

export async function runPiReference(cli: string, root: string, provider: string,
  desktop: Record<string, string | undefined>, session: string, turn: string) {
  const dir = join(root, "pi-reference");
  mkdirSync(dir, { mode: 0o700 });
  const writeConfig = (name: string, data: object) =>
    writeFileSync(join(dir, name), JSON.stringify(data), { mode: 0o600 });
  writeConfig("models.json", { providers: { localfixture: {
    api: "openai-completions", baseUrl: provider + "/v1", apiKey: "fixture", models: [{ id: "parity" }],
  } } });
  writeConfig("mcp.json", { mcpServers: { lxe_desktop: {
    command: process.execPath, args: [import.meta.path, desktop.LXE_DESKTOP_MCP_SCRIPT, session, turn],
    env: { LXE_DESKTOP_MCP_PIPE: desktop.LXE_DESKTOP_MCP_PIPE, LXE_DESKTOP_MCP_TOKEN: desktop.LXE_DESKTOP_MCP_TOKEN },
    exposure: "codemode", description: "Manage scheduled tasks in the desktop app.",
  } } });
  const ref = Bun.spawn(["node", cli, "--model", "localfixture/parity", "--no-session", "-p", "List failed scheduled runs"], {
    cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([ref.exited, new Response(ref.stdout).text(), new Response(ref.stderr).text()]);
  if (status !== 0) throw new Error(`Pi CLI exited with ${status}\n${stderr}\n${stdout}`);
}
