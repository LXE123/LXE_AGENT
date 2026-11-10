import { DESKTOP_MCP_META, DESKTOP_MCP_NAME } from "@lxe/desktop-protocol";
import type { McpServerConfig } from "@lxe/runtime";

/** Only desktop exec calls receive this limited capability. Never pass it on to stdio MCP servers. */
export function takeMcpCliEnvironment(environment: Record<string, string | undefined>) {
  const { LXE_MCP_CLI_PIPE, LXE_MCP_CLI_TOKEN } = environment;
  for (const key of ["LXE_MCP_CLI_PIPE", "LXE_MCP_CLI_TOKEN"]) { delete environment[key]; delete process.env[key]; }
  if (!LXE_MCP_CLI_PIPE || !LXE_MCP_CLI_TOKEN) return undefined;
  return { LXE_MCP_CLI_PIPE, LXE_MCP_CLI_TOKEN };
}

export function takeDesktopMcpConfig(environment: Record<string, string | undefined>): McpServerConfig | undefined {
  const names = ["LXE_DESKTOP_MCP_COMMAND", "LXE_DESKTOP_MCP_SCRIPT", "LXE_DESKTOP_MCP_PIPE", "LXE_DESKTOP_MCP_TOKEN", "LXE_DESKTOP_MCP_ENABLED"] as const;
  const [command, script, pipe, token, enabled] = names.map(name => environment[name]);
  // Never inherit the app credential into exec commands or third-party MCPs.
  for (const name of names) { delete environment[name]; delete process.env[name]; }
  if (!command && !script && !pipe && !token) return undefined;
  if (!command || !script || !pipe || !token) throw new Error("Incomplete desktop MCP launch configuration");
  return {
    name: DESKTOP_MCP_NAME, enabled: enabled !== "0", transport: "stdio", protocolMode: "2026-07-28",
    command, args: [script], cwd: "", env: { LXE_DESKTOP_MCP_PIPE: pipe, LXE_DESKTOP_MCP_TOKEN: token },
    url: "", headers: {}, envHeaders: {}, bearerTokenEnvVar: "", connectorId: "", connectorName: "桌面应用",
    connectorDescription: "Manage scheduled tasks in the desktop app.", startupTimeoutMs: 10_000, toolTimeoutMs: 30_000,
    enabledTools: new Set(), disabledTools: new Set(), exposure: "codemode", platforms: ["desktop"], callerMetadataKey: DESKTOP_MCP_META,
  };
}
