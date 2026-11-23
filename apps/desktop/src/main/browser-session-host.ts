/** Shared loopback transport and lease lifecycle for desktop browser sessions.
 * Page operations and authentication remain separate session implementations.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { browserDiagnostic } from "./browser-diagnostics";
import { createLogger, type Logger } from "@lxe/core";

type CloseReason = "explicit_close" | "idle_timeout" | "owner_deleted" | "host_shutdown" | "client_disconnect";

interface Closure {
  reason: CloseReason;
  closed_at: string;
}

export interface BrowserSession {
  readonly currentUrl: string;
  readonly ownerSessionId?: string;
  invoke(operation: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  diagnostic(error: unknown): { exception_type: string; message: string };
}

interface Lease {
  session: BrowserSession;
  touched: number;
  busy: boolean;
  closing?: Promise<void>;
}

export class BrowserSessionHost {
  private readonly token = randomBytes(32).toString("hex");
  private readonly leases = new Map<string, Lease>();
  private readonly closures = new Map<string, Closure>();
  private readonly logger: Logger;
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private timer: ReturnType<typeof setInterval> | undefined;
  private endpoint = "";
  private stopping = false;

  constructor(
    private readonly createSession: (arguments_: Record<string, unknown>) => Promise<BrowserSession>,
    private readonly options: {
      route: string;
      environmentPrefix: string;
      idleMs?: number;
      disconnectPolicy?: "close_session" | "keep_session";
      logger?: Logger;
    },
  ) {
    this.logger = options.logger ?? createLogger("desktop.browser.host");
  }

  async start(): Promise<void> {
    if (this.endpoint) return;
    this.stopping = false;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Browser host has no TCP address");
    this.endpoint = `http://127.0.0.1:${address.port}`;
    this.timer = setInterval(() => { void this.expire(); }, Math.min(1000, this.options.idleMs ?? 180_000));
    this.timer.unref();
  }

  environment(): Record<string, string> {
    if (!this.endpoint || this.stopping) throw new Error("Browser host is not running");
    return {
      [`${this.options.environmentPrefix}_URL`]: this.endpoint,
      [`${this.options.environmentPrefix}_TOKEN`]: this.token,
    };
  }

  async stop(strict = false): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    const results = await Promise.allSettled([...this.leases.keys()].map(id => this.closeLease(id, "host_shutdown")));
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.endpoint = "";
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (strict && failures.length) {
      throw new AggregateError(
        failures.map(result => result.reason),
        failures.map(result => String(result.reason)).join("\n"),
      );
    }
  }

  async closeOwner(ownerSessionId: string): Promise<void> {
    await Promise.all([...this.leases]
      .filter(([, lease]) => lease.session.ownerSessionId === ownerSessionId)
      .map(([id]) => this.closeLease(id, "owner_deleted")));
  }

  private async closeLease(id: string, reason: CloseReason): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) return;
    if (lease.closing) return lease.closing;
    const fields = { browser_session_id: id, owner_session_id: lease.session.ownerSessionId, route: this.options.route, reason };
    this.logger.info("browser_session_close_requested", fields);
    lease.closing = Promise.resolve().then(async () => {
      await lease.session.close();
      const closure = { reason, closed_at: new Date().toISOString() };
      this.closures.set(id, closure);
      // Recent closure diagnostics are disposable and never used to restore a session.
      if (this.closures.size > 100) this.closures.delete(this.closures.keys().next().value!);
      this.leases.delete(id);
      this.logger.info("browser_session_closed", { ...fields, closed_at: closure.closed_at });
    }).catch(error => {
      this.logger.error("browser_session_close_failed", { ...fields, error: lease.session.diagnostic(error) });
      throw error;
    }).finally(() => { delete lease.closing; });
    return lease.closing;
  }

  private async expire(): Promise<void> {
    await Promise.allSettled([...this.leases].filter(([, lease]) =>
      !lease.busy && Date.now() - lease.touched >= (this.options.idleMs ?? 180_000),
    ).map(([id]) => this.closeLease(id, "idle_timeout")));
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
        this.reply(response, 403, { ok: false, error: { exception_type: "AuthorizationError", message: "Browser host authorization rejected" } });
        request.resume();
        return;
      }
      if (request.method !== "POST" || request.url !== this.options.route || this.stopping) {
        this.reply(response, 404, { ok: false, error: { exception_type: "ProtocolError", message: "Browser endpoint unavailable" } });
        request.resume();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error("Browser request exceeds 16 KiB");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const operation = String(body.operation ?? "");
      const arguments_ = body.arguments;
      if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
        throw new Error("Browser arguments must be an object");
      }
      const args = arguments_ as Record<string, unknown>;
      let result: unknown;
      if (operation === "open") {
        const session = await this.createSession(args);
        if (this.stopping || response.destroyed) {
          await session.close();
          return;
        }
        id = randomUUID();
        lease = { session, touched: Date.now(), busy: false };
        this.leases.set(id, lease);
        this.logger.info("browser_session_opened", {
          browser_session_id: id,
          owner_session_id: session.ownerSessionId,
          route: this.options.route,
        });
        result = { session_id: id };
      } else {
        id = String(body.session_id ?? "");
        lease = this.leases.get(id);
        if (operation === "close") {
          await this.closeLease(id, "explicit_close");
          result = null;
        } else {
          if (!lease) {
            const closure = this.closures.get(id);
            throw new Error(closure
              ? `Browser session is closed or expired; reason=${closure.reason}; closed_at=${closure.closed_at}`
              : "Browser session is unavailable; no closure record exists in this host");
          }
          if (lease.closing) throw new Error("Browser session is closing");
          if (lease.busy) throw new Error("Browser session already has an active operation");
          lease.busy = true;
          const startedAt = Date.now();
          let disconnectRecorded = false;
          const disconnected = (): void => {
            if (response.writableEnded || disconnectRecorded) return;
            disconnectRecorded = true;
            const policy = this.options.disconnectPolicy ?? "close_session";
            this.logger.warn("browser_request_disconnected", {
              browser_session_id: id,
              owner_session_id: lease?.session.ownerSessionId,
              route: this.options.route,
              operation,
              elapsed_ms: Date.now() - startedAt,
              disconnect_policy: policy,
            });
            if (policy === "close_session") void this.closeLease(id, "client_disconnect").catch(() => {});
          };
          const socket = request.socket;
          response.once("close", disconnected);
          socket.once("close", disconnected);
          response.once("finish", () => socket.removeListener("close", disconnected));
          try {
            result = await lease.session.invoke(operation, args);
          } catch (error) {
            this.logger.warn("browser_operation_failed", {
              browser_session_id: id,
              route: this.options.route,
              operation,
              elapsed_ms: Date.now() - startedAt,
              error: lease.session.diagnostic(error),
            });
            throw error;
          } finally {
            response.off("close", disconnected);
            socket.off("close", disconnected);
            lease.busy = false;
            lease.touched = Date.now();
          }
        }
      }
      this.reply(response, 200, { ok: true, result, current_url: lease?.session.currentUrl ?? "" });
    } catch (error) {
      const diagnostic = lease?.session.diagnostic(error) ?? browserDiagnostic(error, [this.token]);
      const closure = !lease ? this.closures.get(id) : undefined;
      this.reply(response, 400, {
        ok: false,
        error: { ...diagnostic, ...(closure ? { closure } : {}) },
        current_url: lease?.session.currentUrl ?? "",
      });
    }
  }
}
