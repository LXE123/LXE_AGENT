import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface LogisticsLoginRequest {
  profile_id: string;
  store_id: string;
  session_id: string;
  expected_revision: number;
}

/** Internal loopback RPC returns login evidence, never decrypted credentials. */
export class LogisticsLoginHost {
  private readonly token = randomBytes(32).toString("hex");
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private endpoint = "";
  private stopping = false;
  constructor(private readonly ensureLogin: (request: LogisticsLoginRequest, signal: AbortSignal) => Promise<unknown>) {}

  async start(): Promise<void> {
    if (this.endpoint) return;
    this.stopping = false;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Logistics login host has no TCP address");
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }
  environment(): Record<string, string> {
    if (!this.endpoint || this.stopping) throw new Error("Logistics login host is not running");
    return { LXE_LOGISTICS_LOGIN_HOST_URL: this.endpoint, LXE_LOGISTICS_LOGIN_HOST_TOKEN: this.token };
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
    this.endpoint = "";
  }
  private reply(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const actual = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${this.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || request.headers.origin) {
        request.resume(); this.reply(response, 403, { success: false, error: { code: "login_host_authorization", message: "Logistics login host authorization rejected" } }); return;
      }
      if (this.stopping || request.method !== "POST" || request.url !== "/v1/logistics/login") {
        request.resume(); this.reply(response, 404, { success: false, error: { code: "login_host_endpoint", message: "Logistics login endpoint unavailable" } }); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4096) throw new Error("Logistics login request exceeds 4 KiB");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const keys = ["profile_id", "store_id", "session_id", "expected_revision"];
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length
        || keys.some(key => !Object.hasOwn(body, key))) throw new Error("Invalid logistics login request fields");
      if (typeof body.profile_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(body.profile_id)
        || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0
        || [body.store_id, body.session_id].some(value => typeof value !== "string" || !value.length || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))) {
        throw new Error("Invalid logistics login request identity or revision");
      }
      if (response.destroyed) return;
      const controller = new AbortController();
      const disconnected = (): void => { if (!response.writableEnded) controller.abort(); };
      response.once("close", disconnected);
      try {
        const result = await this.ensureLogin(body, controller.signal);
        this.reply(response, 200, result);
      } finally {
        response.removeListener("close", disconnected);
      }
    } catch (error) {
      const message = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`
        .replaceAll(this.token, "[redacted]");
      this.reply(response, 400, { success: false, auth_refresh_required: false,
        error: { code: "login_host_failed", message: message.length > 4000 ? message.slice(0, 4000) + " [truncated]" : message } });
    }
  }
}
