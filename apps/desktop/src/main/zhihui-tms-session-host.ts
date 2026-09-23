import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const ENDPOINT_PATH = "/v1/zhihui-tms-session";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_API_TOKEN_CHARS = 8_192;
const ACCOUNT_FINGERPRINT = /^[a-f0-9]{64}$/u;

export interface ZhihuiTmsSessionStore {
  read(accountFingerprint: string): string | null;
  save(accountFingerprint: string, apiToken: string): void;
  clear(accountFingerprint: string): void;
}

type SessionOperation = "read" | "write" | "clear";

interface SessionRequest {
  operation: SessionOperation;
  accountFingerprint: string;
  apiToken?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class ZhihuiTmsSessionHost {
  private readonly capability = randomBytes(32).toString("hex");
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private endpoint = "";
  private stopping = false;

  constructor(private readonly store: ZhihuiTmsSessionStore) {}

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
    if (!address || typeof address === "string") throw new Error("Zhihui TMS session host has no TCP address");
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }

  environment(): Record<string, string> {
    if (!this.endpoint || this.stopping) throw new Error("Zhihui TMS session host is not running");
    return {
      LXE_ZHIHUI_TMS_SESSION_HOST_URL: this.endpoint,
      LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN: this.capability,
    };
  }

  async stop(): Promise<void> {
    if (!this.endpoint) return;
    this.stopping = true;
    this.server.closeAllConnections();
    await new Promise<void>(resolve => { this.server.close(() => resolve()); });
    this.endpoint = "";
  }

  private reply(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
  }

  private authorized(request: IncomingMessage): boolean {
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.capability}`);
    return !request.headers.origin
      && actual.length === expected.length
      && timingSafeEqual(actual, expected);
  }

  private async parseRequest(request: IncomingMessage): Promise<SessionRequest> {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) throw new Error("request exceeds size limit");
      chunks.push(buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!isObject(body)) throw new Error("request body must be an object");
    const operation = body.operation;
    const accountFingerprint = body.account_fingerprint;
    if (
      (operation !== "read" && operation !== "write" && operation !== "clear")
      || typeof accountFingerprint !== "string"
      || !ACCOUNT_FINGERPRINT.test(accountFingerprint)
    ) {
      throw new Error("invalid session request");
    }
    const allowed = operation === "write"
      ? ["operation", "account_fingerprint", "api_token"]
      : ["operation", "account_fingerprint"];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error("invalid session request");
    if (operation !== "write") return { operation, accountFingerprint };
    const apiToken = body.api_token;
    if (typeof apiToken !== "string" || !apiToken || apiToken.length > MAX_API_TOKEN_CHARS) {
      throw new Error("invalid session request");
    }
    return { operation, accountFingerprint, apiToken };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) {
        this.reply(response, 403, { ok: false, error: "authorization rejected" });
        request.resume();
        return;
      }
      if (this.stopping || request.method !== "POST" || request.url !== ENDPOINT_PATH) {
        this.reply(response, 404, { ok: false, error: "endpoint unavailable" });
        request.resume();
        return;
      }
      const input = await this.parseRequest(request);
      if (input.operation === "read") {
        this.reply(response, 200, { ok: true, result: { api_token: this.store.read(input.accountFingerprint) } });
        return;
      }
      if (input.operation === "write") {
        this.store.save(input.accountFingerprint, input.apiToken!);
        this.reply(response, 200, { ok: true, result: null });
        return;
      }
      this.store.clear(input.accountFingerprint);
      this.reply(response, 200, { ok: true, result: null });
    } catch {
      this.reply(response, 400, { ok: false, error: "session request rejected" });
      request.resume();
    }
  }
}
