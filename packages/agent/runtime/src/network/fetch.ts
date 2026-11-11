import { createLogger, type Logger } from "@lxe/core";
// The package entry bypasses Bun's built-in "undici" compatibility shim, which
// delegates to Bun fetch and ignores the direct dispatcher on Bun 1.4.2.
import { Agent, FormData as DirectFormData, fetch as directFetch, type RequestInit as DirectRequestInit } from "undici/index.js";
import { cachedSystemProxy, type ManualSystemProxy } from "./system-proxy";
import { environmentRoute, systemRoute } from "./proxy-route";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface FetchOptions {
  environment?: Record<string, string | undefined>;
  systemProxy?: () => Promise<ManualSystemProxy>;
  fetch?: Fetch;
  logger?: Logger;
}

const directAgent = new Agent();
// Bun 1.4.2 ignores proxy:false and falls back to environment proxies. An explicit
// Undici Agent guarantees direct sockets without mutating shared process.env.
const routedFetch: Fetch = async (input, init) => {
  if ((init as RequestInit & { proxy?: string | false })?.proxy !== false) return globalThis.fetch(input, init);
  let request = init;
  if (init?.body instanceof FormData) {
    // Undici's FormData brand is distinct from Bun's; retain files without buffering them.
    const body = new DirectFormData();
    init.body.forEach((value, name) => {
      if (typeof value === "string") body.append(name, value);
      else body.append(name, value, value.name);
    });
    request = { ...init, body: body as unknown as FormData };
  }
  const response = await directFetch(String(input), { ...request, dispatcher: directAgent, duplex: "half" } as DirectRequestInit);
  const signal = init?.signal;
  if (!response.body || !signal) return response as unknown as Response;
  // Undici closes the socket on abort under Bun 1.4.2, but a pending body.read()
  // can remain unresolved. Propagate cancellation to the consumer's stream too.
  const reader = response.body.getReader();
  let abort!: () => void;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        cleanup(); controller.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { cleanup(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { cleanup(); controller.error(error); }
    },
    cancel(reason) { cleanup(); return reader.cancel(reason); },
  });
  const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperties(result, { url: { value: response.url }, redirected: { value: response.redirected, configurable: true } });
  return result;
};

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  let abort!: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      operation.then(resolve, reject);
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally { signal.removeEventListener("abort", abort); }
}

/** Shared by providers, HTTP MCP and OAuth. No mutation of global fetch or child-process env. */
export function createHarnessFetch(options: FetchOptions = {}): Fetch {
  const systemProxy = options.systemProxy ?? cachedSystemProxy();
  const environment = options.environment ?? process.env;
  const logger = options.logger ?? createLogger("runtime.network");
  const send: Fetch = options.fetch ?? routedFetch;
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : input);
    if (!["http:", "https:"].includes(url.protocol)) return send(input, init);
    let request = { ...init };
    if (input instanceof Request) {
      const merged = new Request(input, init);
      request = { ...init, method: merged.method, headers: merged.headers, body: merged.body,
        signal: merged.signal, redirect: merged.redirect, credentials: merged.credentials,
        cache: merged.cache, mode: merged.mode, referrer: merged.referrer, referrerPolicy: merged.referrerPolicy };
    }
    const redirect = request.redirect ?? "follow";
    for (let count = 0; ; count++) {
      request.signal?.throwIfAborted();
      // Never retry a failed proxy via a direct connection: leave retry policy to the caller.
      const route = environmentRoute(url, environment) ?? systemRoute(url, await abortable(systemProxy(), request.signal));
      logger.debug("http_request_route", { destination: url.origin, source: route.source,
        proxy: route.proxy ? new URL(route.proxy).origin : undefined });
      const response = await send(url, { ...request, proxy: route.proxy, redirect: redirect === "follow" ? "manual" : redirect } as RequestInit);
      const location = response.headers.get("location");
      if (redirect !== "follow" || ![301, 302, 303, 307, 308].includes(response.status) || location === null) {
        if (count) Object.defineProperty(response, "redirected", { value: true });
        return response;
      }
      await response.body?.cancel();
      if (count >= 20) throw new TypeError("HTTP redirect limit exceeded");
      const next = new URL(location, url);
      if (!["http:", "https:"].includes(next.protocol) || next.username || next.password) throw new TypeError("Invalid HTTP redirect target");
      const method = (request.method ?? "GET").toUpperCase();
      const headers = new Headers(request.headers);
      if ((response.status === 303 && method !== "GET" && method !== "HEAD") || ([301, 302].includes(response.status) && method === "POST")) {
        request = { ...request, method: "GET", body: undefined };
        for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location", "transfer-encoding"]) headers.delete(name);
      } else if (request.body instanceof ReadableStream || (request.body && Symbol.asyncIterator in Object(request.body))) {
        throw new TypeError("Cannot replay a streaming request body after an HTTP redirect");
      }
      if (next.origin !== url.origin) {
        for (const name of ["authorization", "x-api-key", "proxy-authorization", "www-authenticate", "cookie", "cookie2", "referer"]) headers.delete(name);
      }
      headers.delete("host");
      request = { ...request, headers };
      url = next;
    }
  };
}

export const harnessFetch = createHarnessFetch();
