import net, { type Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_MCP_PIPE_VERSION } from "@lxe/desktop-protocol";
import { sanitizeLogValueWithPolicy } from "@lxe/core";

const MAX_FRAME = 1_048_576;
export function encodePipeFrame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > MAX_FRAME) throw new Error("Desktop tool response exceeds the 1 MiB frame limit");
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
function readFrame(socket: Socket, receive: (value: unknown) => void): void {
  let buffer = Buffer.alloc(0), complete = false;
  socket.on("data", (chunk: Buffer) => {
    try {
      if (complete) throw new Error("Only one request is allowed per pipe connection");
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME + 4) throw new Error("Desktop tool frame exceeds 1 MiB");
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (!length || length > MAX_FRAME) throw new Error("Invalid desktop tool frame length");
      if (buffer.length < length + 4) return;
      if (buffer.length !== length + 4) throw new Error("Unexpected extra desktop tool frame");
      complete = true;
      receive(JSON.parse(buffer.subarray(4).toString("utf8")));
    } catch (error) { socket.destroy(error instanceof Error ? error : new Error(String(error))); }
  });
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pipe message");
  return value as Record<string, unknown>;
};

export async function startDesktopPipe(options: {
  token: string;
  call: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
}): Promise<{ path: string; close(): Promise<void> }> {
  const directory = process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "lxe-mcp-"));
  if (directory) await chmod(directory, 0o700);
  const path = directory ? join(directory, "app.sock") : `\\\\.\\pipe\\lxe-desktop-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const controller = new AbortController();
    socket.setTimeout(30_000, () => socket.destroy(new Error("Desktop pipe request timed out")));
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); controller.abort(); });
    readFrame(socket, value => {
      void (async () => {
        let id: unknown = null;
        try {
          const message = record(value); id = message.id;
          if (message.jsonrpc !== "2.0" || typeof id !== "string" || typeof message.method !== "string") throw new Error("Invalid desktop pipe request");
          if (message.version !== DESKTOP_MCP_PIPE_VERSION) throw new Error("Desktop pipe version mismatch");
          const provided = Buffer.from(typeof message.token === "string" ? message.token : "");
          const expected = Buffer.from(options.token);
          if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("Desktop pipe authentication failed");
          const result = await options.call(message.method, message.params, controller.signal);
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

export function requestDesktopPipe(path: string, token: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path), id = randomUUID();
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Desktop tool call cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(30_000, () => finish(new Error("Desktop pipe request timed out")));
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(new Error("Desktop pipe closed before returning a response")));
    readFrame(socket, value => {
      try {
        const response = record(value);
        if (response.jsonrpc !== "2.0" || response.id !== id) throw new Error("Desktop pipe response ID mismatch");
        if (response.error) throw new Error(String(record(response.error).message));
        if (!("result" in response)) throw new Error("Desktop pipe response has no result");
        finish(undefined, response.result);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("connect", () => {
      try { socket.write(encodePipeFrame({ jsonrpc: "2.0", id, version: DESKTOP_MCP_PIPE_VERSION, token, method, params })); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
