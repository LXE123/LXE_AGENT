import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
  const server = new Server({ name: "session-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "where", description: "Return workspace and process identity", inputSchema: { type: "object" } }] }));
  server.setRequestHandler("tools/call", async () => ({ content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(), pid: process.pid }) }] }));
  return server;
});
