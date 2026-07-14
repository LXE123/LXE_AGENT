import { readFileSync } from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { createLogger, type Logger } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";

export interface BunDashboardOptions {
  enabled: boolean;
  host: string;
  port: number;
  autoFallback: boolean;
  projectRoot: string;
  health: () => Promise<JsonObject>;
  channels: () => Promise<Record<string, JsonObject>>;
  api?: (request: Request, url: URL) => Promise<Response | undefined>;
  logger?: Logger;
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { "access-control-allow-origin": "*" } });

const contentType = (path: string): string => {
  const extension = extname(path).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function dashboardAccessUrl(host: string, port: number): string {
  const configured = String(host || "127.0.0.1").trim() || "127.0.0.1";
  const accessible = ["0.0.0.0", "::", "[::]"].includes(configured)
    ? "127.0.0.1"
    : configured;
  const unwrapped = accessible.startsWith("[") && accessible.endsWith("]")
    ? accessible.slice(1, -1)
    : accessible;
  const urlHost = unwrapped.includes(":") ? `[${unwrapped}]` : unwrapped;
  return `http://${urlHost}:${port}`;
}

export class BunDashboardServer {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private error = "";
  private readonly logger: Logger;
  private fallbackUsed = false;
  readonly requestedPort: number;
  port: number;

  constructor(private readonly options: BunDashboardOptions) {
    this.requestedPort = options.port;
    this.port = options.port;
    this.logger = options.logger ?? createLogger("gateway.dashboard");
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get url(): string {
    return dashboardAccessUrl(this.options.host, this.port);
  }

  get host(): string {
    return this.options.host;
  }

  get usedPortFallback(): boolean {
    return this.fallbackUsed;
  }

  async start(): Promise<boolean> {
    if (!this.enabled) return true;
    if (this.server) return true;
    this.error = "";
    this.fallbackUsed = false;
    let requestedPortError = "";
    try {
      this.server = this.serve(this.requestedPort);
    } catch (cause) {
      requestedPortError = errorText(cause);
      if (!this.options.autoFallback || this.requestedPort === 0) {
        this.error = requestedPortError;
        return false;
      }
      try {
        this.server = this.serve(0);
        this.fallbackUsed = true;
      } catch (fallbackCause) {
        this.error = errorText(fallbackCause);
        return false;
      }
    }
    this.port = this.server.port ?? this.requestedPort;
    if (this.fallbackUsed) {
      this.logger.warn("dashboard_port_fallback", {
        requested_port: this.requestedPort,
        actual_port: this.port,
        reason: requestedPortError,
      });
    }
    this.logger.info("dashboard_listening", {
      url: this.url,
      host: this.options.host,
      port: this.port,
      requested_port: this.requestedPort,
      port_fallback: this.fallbackUsed,
    });
    return true;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await server.stop(true);
  }

  state(): JsonObject {
    return {
      enabled: this.enabled,
      url: this.url,
      started: Boolean(this.server),
      running: Boolean(this.server),
      error: this.error,
    };
  }

  private serve(port: number): ReturnType<typeof Bun.serve> {
    return Bun.serve({
      hostname: this.options.host,
      port,
      fetch: (request) => this.handle(request),
    });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, PATCH, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return json({ detail: "method not allowed" }, 405);
      return json({ status: "ok", gateway: await this.options.health() });
    }
    if (url.pathname === "/api/channels/health") {
      if (request.method !== "GET") return json({ detail: "method not allowed" }, 405);
      const items = await this.options.channels();
      return json({ items, total: Object.keys(items).length });
    }
    if (url.pathname.startsWith("/api/")) {
      const response = await this.options.api?.(request, url);
      return response ?? json({ detail: "not found" }, 404);
    }
    if (request.method !== "GET") return json({ detail: "method not allowed" }, 405);
    return this.staticResponse(url.pathname);
  }

  private staticResponse(pathname: string): Response {
    const root = normalize(join(this.options.projectRoot, "apps", "dashboard", "dist"));
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const candidate = normalize(join(root, requested));
    const safeCandidate = relative(root, candidate).startsWith("..") ? join(root, "index.html") : candidate;
    try {
      return new Response(readFileSync(safeCandidate), {
        headers: { "content-type": contentType(safeCandidate) },
      });
    } catch {
      try {
        return new Response(readFileSync(join(root, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch {
        return json({ detail: "dashboard UI is not built" }, 503);
      }
    }
  }
}
