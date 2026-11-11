import net, { type Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_MCP_PIPE_VERSION } from "./desktop-mcp";
import { encodePipeFrame, readFrame, pipeRecord } from "./local-pipe";
import { sanitizeLogValueWithPolicy } from "@lxe/core";

export async function startDesktopPipe(options: {
  token: string;
  timeoutMs?: number;
  call: (method: string, params: unknown, signal: AbortSignal, progress: (value: unknown) => void) => Promise<unknown>;
}): Promise<{ path: string; close(): Promise<void> }> {
  const directory = process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "lxe-mcp-"));
  if (directory) await chmod(directory, 0o700);
  const path = directory ? join(directory, "app.sock") : `\\\\.\\pipe\\lxe-desktop-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    socket.setTimeout(options.timeoutMs ?? 30_000, () => socket.destroy(new Error("Desktop pipe request timed out")));
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); controller.abort(); });
    readFrame(socket, value => {
      void (async () => {
        let id: unknown = null;
        try {
          const message = pipeRecord(value); id = message.id;
          if (message.jsonrpc !== "2.0" || typeof id !== "string" || typeof message.method !== "string") throw new Error("Invalid desktop pipe request");
          if (message.version !== DESKTOP_MCP_PIPE_VERSION) throw new Error("Desktop pipe version mismatch");
          const provided = Buffer.from(typeof message.token === "string" ? message.token : "");
          const expected = Buffer.from(options.token);
          if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("Desktop pipe authentication failed");
          const progress = (value: unknown) => {
            if (message.progress === true && !controller.signal.aborted && !socket.writableEnded) {
              socket.write(encodePipeFrame({ jsonrpc: "2.0", method: "progress", params: { requestId: id, value } }));
            }
          };
          const result = await options.call(message.method, message.params, controller.signal, progress);
          if (!controller.signal.aborted) socket.end(encodePipeFrame({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          if (!socket.destroyed) socket.end(encodePipeFrame({ jsonrpc: "2.0", id, error: { code: -32000,
            message: sanitizeLogValueWithPolicy(error instanceof Error ? error.message : String(error), { maxString: 4000 }) } }));
        }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
  } catch (error) { if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  } };
}
