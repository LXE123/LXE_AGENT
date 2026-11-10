import net, { type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { DESKTOP_MCP_PIPE_VERSION } from "./desktop-mcp";

const MAX_FRAME = 1_048_576;
export function encodePipeFrame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > MAX_FRAME) throw new Error("Desktop tool response exceeds the 1 MiB frame limit");
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
export function readFrame(socket: Socket, receive: (value: unknown) => void): void {
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
export const pipeRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pipe message");
  return value as Record<string, unknown>;
};

export function requestDesktopPipe(path: string, token: string, method: string, params: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
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
    socket.setTimeout(timeoutMs, () => finish(new Error("Desktop pipe request timed out")));
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(new Error("Desktop pipe closed before returning a response")));
    readFrame(socket, value => {
      try {
        const response = pipeRecord(value);
        if (response.jsonrpc !== "2.0" || response.id !== id) throw new Error("Desktop pipe response ID mismatch");
        if (response.error) throw new Error(String(pipeRecord(response.error).message));
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
