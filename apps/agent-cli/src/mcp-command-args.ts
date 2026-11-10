import { parseArgs } from "node:util";
import { DESKTOP_MCP_NAME } from "@lxe/desktop-protocol";
import { mcpNamespace } from "@lxe/runtime";

export const usage = `Usage: agent-cli mcp <command>
  list [--json]                          List servers, connection state and tools
  add <name> [options] -- <cmd> [args]   Add or replace a user stdio server
  add <name> [options] --url <url>       Add or replace a user HTTP server
  remove <name>                          Remove its user configuration (keep credentials)
  login <name> [--timeout <seconds>]     Sign in and verify the connection
  logout <name>                          Forget its saved OAuth credentials
Add options: --exposure <codemode|deferred|direct|hidden>, --description <text>,
  stdio: --cwd <dir>, --env KEY=VALUE (repeatable)
  HTTP:  --header KEY=VALUE (repeatable), --bearer-token-env-var <name>
`;

type Command = { kind: "list"; json: boolean } | { kind: "login"; name: string; timeout: number }
  | { kind: "remove" | "logout"; name: string } | { kind: "add"; name: string; definition: Record<string, unknown> };

function pairs(entries: string[] | undefined, header: boolean) {
  return Object.fromEntries((entries ?? []).map(entry => {
    const split = entry.indexOf("=");
    if (split < 1) throw new Error("Expected " + (header ? "--header" : "--env") + " KEY=VALUE");
    const key = entry.slice(0, split);
    if (header && !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(key)) throw new Error("Invalid HTTP header name");
    if (header && /[\r\n]/.test(entry.slice(split + 1))) throw new Error("Invalid HTTP header value");
    return [key, entry.slice(split + 1)];
  }));
}

export function parseMcpCommand([kind, ...args]: string[]): Command {
  if (kind === "list" && (!args.length || (args.length === 1 && args[0] === "--json"))) return { kind, json: !!args.length };
  const [name, ...rest] = args;
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || name.startsWith("-")) throw new Error("Expected a configured MCP server name");
  if (kind === "remove" || kind === "add") {
    if (mcpNamespace(name) === mcpNamespace(DESKTOP_MCP_NAME)) throw new Error("The mcp__lxe_desktop namespace is managed by the desktop app");
  }
  if ((kind === "remove" || kind === "logout") && !rest.length) return { kind, name };
  if (kind === "login") {
    const { values } = parseArgs({ args: rest, options: { timeout: { type: "string", default: "300" } } });
    const seconds = Number(values.timeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("--timeout must be between 1 and 300 seconds");
    return { kind, name, timeout: seconds * 1_000 };
  }
  if (kind !== "add") throw new Error("Invalid MCP command or arguments");
  const split = rest.indexOf("--");
  const { values: v } = parseArgs({ args: split < 0 ? rest : rest.slice(0, split), options: {
    url: { type: "string" }, cwd: { type: "string" }, env: { type: "string", multiple: true },
    header: { type: "string", multiple: true }, "bearer-token-env-var": { type: "string" },
    description: { type: "string" }, exposure: { type: "string" },
  } });
  const common = { exposure: v.exposure ?? "codemode", ...(v.description && { connector_description: v.description }) };
  if (split >= 0) {
    const [command, ...argv] = rest.slice(split + 1);
    if (!command || v.url !== undefined || v.header || v["bearer-token-env-var"] !== undefined) throw new Error("Expected -- <command> [args] without HTTP options");
    return { kind, name, definition: { ...common, transport: "stdio", command, args: argv,
      ...(v.env && { env: pairs(v.env, false) }), ...(v.cwd && { cwd: v.cwd }) } };
  }
  const url = v.url && URL.parse(v.url);
  if (!url || !["http:", "https:"].includes(url.protocol) || v.cwd !== undefined || v.env) throw new Error("Expected --url <http(s) URL> without stdio options");
  return { kind, name, definition: { ...common, transport: "streamable-http", url: v.url,
    ...(v.header && { headers: pairs(v.header, true) }), ...(v["bearer-token-env-var"] && { bearer_token_env_var: v["bearer-token-env-var"] }) } };
}
