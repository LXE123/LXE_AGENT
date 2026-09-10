import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface AuthBrowserSession {
  readonly currentUrl: string;
  invoke(operation: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  diagnostic(error: unknown): { exception_type: string; message: string };
}

interface Lease {
  session: AuthBrowserSession;
  touched: number;
  busy: boolean;
}

export class AuthBrowserHost {
  private readonly token = randomBytes(32).toString("hex");
  private readonly leases = new Map<string, Lease>();
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private timer: ReturnType<typeof setInterval> | undefined;
  private endpoint = "";
  private stopping = false;

  constructor(
    private readonly createSession: (headless: boolean) => Promise<AuthBrowserSession>,
    private readonly idleMs = 180_000,
  ) {}

  async start(): Promise<void> {
    if (this.endpoint) return;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Auth browser host has no TCP address");
    this.endpoint = `http://127.0.0.1:${address.port}`;
    this.timer = setInterval(() => { void this.expire(); }, Math.min(1000, this.idleMs));
    this.timer.unref();
  }

  environment(): Record<string, string> {
    if (!this.endpoint || this.stopping) throw new Error("Auth browser host is not running");
    return { LXE_AUTH_BROWSER_HOST_URL: this.endpoint, LXE_AUTH_BROWSER_HOST_TOKEN: this.token };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.leases.keys()].map(id => this.closeLease(id)));
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.endpoint = "";
  }

  private async closeLease(id: string): Promise<void> {
    const lease = this.leases.get(id);
    this.leases.delete(id);
    await lease?.session.close();
  }

  private async expire(): Promise<void> {
    await Promise.allSettled([...this.leases].filter(([, lease]) =>
      !lease.busy && Date.now() - lease.touched >= this.idleMs,
    ).map(([id]) => this.closeLease(id)));
  }

  private reply(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let lease: Lease | undefined;
    let id = "";
    try {
      const actual = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || request.headers.origin) {
        this.reply(response, 403, { ok: false, error: { exception_type: "AuthorizationError", message: "Auth browser host authorization rejected" } });
        request.resume();
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/auth-browser" || this.stopping) {
        this.reply(response, 404, { ok: false, error: { exception_type: "ProtocolError", message: "Auth browser endpoint unavailable" } });
        request.resume();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error("Auth browser request exceeds 16 KiB");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const operation = String(body.operation ?? "");
      const arguments_ = body.arguments;
      if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
        throw new Error("Auth browser arguments must be an object");
      }
      const args = arguments_ as Record<string, unknown>;
      let result: unknown;
      if (operation === "open") {
        if (typeof args.headless !== "boolean") throw new Error("headless must be boolean");
        const session = await this.createSession(args.headless);
        if (this.stopping || response.destroyed) {
          await session.close();
          return;
        }
        id = randomUUID();
        lease = { session, touched: Date.now(), busy: false };
        this.leases.set(id, lease);
        result = { session_id: id };
      } else {
        id = String(body.session_id ?? "");
        lease = this.leases.get(id);
        if (!lease) throw new Error("Auth browser session is closed or expired");
        if (operation === "close") {
          await this.closeLease(id);
          result = null;
        } else {
          if (lease.busy) throw new Error("Auth browser session already has an active operation");
          lease.busy = true;
          const disconnected = (): void => {
            if (!response.writableEnded) void this.closeLease(id).catch(() => {});
          };
          const socket = request.socket;
          response.once("close", disconnected);
          socket.once("close", disconnected);
          response.once("finish", () => socket.removeListener("close", disconnected));
          try {
            result = await lease.session.invoke(operation, args);
          } finally {
            lease.busy = false;
            lease.touched = Date.now();
          }
        }
      }
      this.reply(response, 200, { ok: true, result, current_url: lease?.session.currentUrl ?? "" });
    } catch (error) {
      const diagnostic = lease?.session.diagnostic(error) ?? {
        exception_type: error instanceof Error ? error.name : "Error",
        message: String(error instanceof Error ? error.message : error).replaceAll(this.token, "[REDACTED]").slice(0, 4000),
      };
      this.reply(response, 400, { ok: false, error: diagnostic, current_url: lease?.session.currentUrl ?? "" });
    }
  }
}
