import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Direct sockets avoid Bun fetch's environment proxy behavior without changing process.env. */
export function saihuNativeFetch(endpoint: string): typeof globalThis.fetch {
  const target = new URL(endpoint);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new Error("Invalid native Saihu MCP endpoint");
  }
  const fetchDirect = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password || url.hash) {
      throw new Error("Native Saihu MCP request target changed");
    }
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const headers = new Headers(request.headers);
    for (const key of ["authorization", "cookie", "proxy-authorization", "host"]) headers.delete(key);
    headers.set("X-LXE-Client", "cli");
    headers.set("Accept-Encoding", "identity");
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    request.signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: request.method, headers: Object.fromEntries(headers), agent: false,
      });
      const abort = () => outgoing.destroy(request.signal.reason instanceof Error
        ? request.signal.reason : new DOMException("Cancelled", "AbortError"));
      request.signal.addEventListener("abort", abort, { once: true });
      outgoing.once("close", () => request.signal.removeEventListener("abort", abort));
      outgoing.once("error", reject);
      outgoing.once("response", incoming => {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        }
        const status = incoming.statusCode ?? 502;
        if ([204, 205, 304].includes(status) || request.method === "HEAD") {
          incoming.resume();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        const encoding = responseHeaders.get("content-encoding");
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
          : encoding === "br" ? createBrotliDecompress() : undefined;
        let stream: Readable = incoming;
        if (decoder) {
          incoming.once("error", error => decoder.destroy(error));
          decoder.once("close", () => incoming.destroy());
          stream = incoming.pipe(decoder);
          responseHeaders.delete("content-encoding"); responseHeaders.delete("content-length");
        }
        // No cookie jar or redirect handling. A 3xx remains an actual protocol response.
        resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      if (request.signal.aborted) abort();
      outgoing.end(body);
    });
  };
  return fetchDirect as typeof globalThis.fetch;
}
