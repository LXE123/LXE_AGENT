import { parseArgs } from "node:util";
import { DESKTOP_MCP_NAME } from "@lxe/desktop-protocol";
import { mcpNamespace } from "@lxe/runtime";

export const usage = `Usage: agent-cli mcp <command>
  list [--json]                          Connect to enabled user servers; report tools and errors
  add <name> [options] -- <cmd> [args]   Add or replace a user stdio server
  add <name> [options] --url <url>       Add or replace a user HTTP server
  remove <name>                          Remove its user configuration (keep credentials)
  login <name> [--timeout <seconds>]     Sign in and verify the connection
  logout <name>                          Forget its saved OAuth credentials
Add options: --exposure <codemode|deferred|direct|hidden>, --description <text>,
  stdio: --cwd <dir>, --env KEY=VALUE (repeatable)
  HTTP:  --header KEY=VALUE (repeatable), --bearer-token-env-var <name>
  OAuth: --oauth-client-id <id>, --oauth-client-secret <secret>,
         --oauth-callback-port <port>, --oauth-client-name <name>,
         --oauth-client-registration dcr (default; CIMD is not supported)
Login timeout: any positive number of seconds (default: 300).
`;

type Command = { kind: "help" } | { kind: "list"; json: boolean } | { kind: "login"; name: string; timeout: number }
  | { kind: "remove"; name: string } | { kind: "logout"; name: string } | { kind: "add"; name: string; definition: Record<string, unknown> };

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
  const commands = ["add", "remove", "list", "login", "logout"];
  if (kind === undefined || (["help", "--help", "-h"].includes(kind) && !args.length)) return { kind: "help" };
  if (kind === "help" && args.length === 1 && commands.includes(args[0]!)) return { kind: "help" };
  if (!commands.includes(kind)) throw new Error(`Unknown MCP command "${kind}". Expected: ${commands.join(", ")}.`);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return { kind: "help" };
  if (kind === "list") {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: false });
    return { kind, json: values.json === true };
  }
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) throw new Error(`Missing MCP server name. Usage: agent-cli mcp ${kind} <name>${kind === "add" ? " [options] (--url <url> | -- <command> [args])" : ""}`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid MCP server name "${name}". Use letters, digits, underscores or hyphens.`);
  if (rest.length === 1 && ["--help", "-h"].includes(rest[0]!)) return { kind: "help" };
  if (kind === "remove" || kind === "add") {
    if (mcpNamespace(name) === mcpNamespace(DESKTOP_MCP_NAME)) throw new Error("The mcp__lxe_desktop namespace is managed by the desktop app");
  }
  if (kind === "remove" || kind === "logout") {
    parseArgs({ args: rest, options: {}, allowPositionals: false });
    return { kind, name };
  }
  if (kind === "login") {
    const { values } = parseArgs({ args: rest, options: { timeout: { type: "string", default: "300" } }, allowPositionals: false });
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number of seconds");
    return { kind, name, timeout: seconds * 1_000 };
  }
  if (kind !== "add") throw new Error("Invalid MCP command or arguments");
  const split = rest.indexOf("--");
  const { values: v } = parseArgs({ args: split < 0 ? rest : rest.slice(0, split), allowPositionals: false, options: {
    url: { type: "string" }, cwd: { type: "string" }, env: { type: "string", multiple: true },
    header: { type: "string", multiple: true }, "bearer-token-env-var": { type: "string" },
    description: { type: "string" }, exposure: { type: "string" },
    "oauth-client-id": { type: "string" }, "oauth-client-secret": { type: "string" },
    "oauth-callback-port": { type: "string" }, "oauth-client-name": { type: "string" },
    "oauth-client-registration": { type: "string" },
  } });
  if (v.exposure !== undefined && !["codemode", "deferred", "direct", "hidden"].includes(v.exposure)) {
    throw new Error("--exposure must be codemode, deferred, direct or hidden");
  }
  const common = { exposure: v.exposure ?? "codemode", ...(v.description && { connector_description: v.description }) };
  if (split >= 0) {
    const [command, ...argv] = rest.slice(split + 1);
    if (!command) throw new Error("Missing executable after --. Usage: agent-cli mcp add <name> [options] -- <command> [args]");
    const misplaced = ["url", "header", "bearer-token-env-var", "oauth-client-id", "oauth-client-secret", "oauth-callback-port", "oauth-client-name", "oauth-client-registration"].find(option => v[option as keyof typeof v] !== undefined);
    if (misplaced) throw new Error(`--${misplaced} only applies to HTTP servers; omit the stdio command after --`);
    return { kind, name, definition: { ...common, transport: "stdio", command, args: argv,
      ...(v.env && { env: pairs(v.env, false) }), ...(v.cwd && { cwd: v.cwd }) } };
  }
  if (v.url === undefined) throw new Error("Specify --url <http(s) URL> or -- <command> [args] when adding an MCP server");
  const url = URL.parse(v.url);
  if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error("--url must be a valid HTTP or HTTPS URL");
  const misplaced = ["cwd", "env"].find(option => v[option as keyof typeof v] !== undefined);
  if (misplaced) throw new Error(`--${misplaced} only applies to stdio servers, not --url`);
  const oauth = {
    ...(v["oauth-client-id"] !== undefined && { clientId: v["oauth-client-id"] }),
    ...(v["oauth-client-secret"] !== undefined && { clientSecret: v["oauth-client-secret"] }),
    ...(v["oauth-callback-port"] !== undefined && { callbackPort: Number(v["oauth-callback-port"]) }),
    ...(v["oauth-client-name"] !== undefined && { clientName: v["oauth-client-name"] }),
    ...(v["oauth-client-registration"] !== undefined && { clientRegistration: v["oauth-client-registration"] }),
  };
  return { kind, name, definition: { ...common, transport: "streamable-http", url: v.url,
    ...(Object.keys(oauth).length && { oauth }),
    ...(v.header && { headers: pairs(v.header, true) }), ...(v["bearer-token-env-var"] && { bearer_token_env_var: v["bearer-token-env-var"] }) } };
}

export function requireMcpServer<T extends { name: string }>(name: string, servers: T[]): T {
  const server = servers.find(item => item.name === name);
  if (server) return server;
  // Prefer the original name when a model supplied its normalized namespace.
  const match = servers.find(item => mcpNamespace(item.name) === mcpNamespace(name.replace(/^mcp__/, "")));
  throw new Error(`MCP server not found: ${name}.${match ? ` Did you mean "${match.name}"? Use the configured server name, not its tool namespace.` : ""}`
    + (servers.length ? ` Configured servers: ${servers.map(item => item.name).join(", ")}.` : " No MCP servers configured."));
}
