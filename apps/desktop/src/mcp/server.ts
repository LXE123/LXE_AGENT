import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DESKTOP_MCP_META } from "@lxe/desktop-protocol";
import { requestDesktopPipe } from "./pipe";
import { desktopTools } from "./tools";

const path = process.env.LXE_DESKTOP_MCP_PIPE;
const token = process.env.LXE_DESKTOP_MCP_TOKEN;
if (!path || !token) throw new Error("Desktop MCP requires an app-managed pipe and credential");
const server = new Server({ name: "lxe-desktop-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => {
  await requestDesktopPipe(path, token, "tools/list", {});
  return { tools: desktopTools };
});
server.setRequestHandler("tools/call", async (request, extra) => {
  try {
    const result = await requestDesktopPipe(path, token, "tools/call", {
      name: request.params.name, arguments: request.params.arguments ?? {}, caller: request.params._meta?.[DESKTOP_MCP_META],
    }, extra.mcpReq.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
  }
});
const transport = serveStdio(() => server);
let closing: Promise<void> | undefined;
const close = () => closing ??= transport.close();
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
process.stdin.once("end", () => { void close(); });
