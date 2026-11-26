import http from "node:http";
import https from "node:https";
import { CloudHttpError, parseCloudError } from "./cloud-errors";


export interface NativeCloudClient {
  request(server: string, path: string, signal: AbortSignal, body?: unknown): Promise<any>;
}

/** Main process only. Dedicated agents avoid system/environment proxies and cookie jars. */
export class DirectNativeCloudClient implements NativeCloudClient {
  async request(server: string, path: string, signal: AbortSignal, body?: unknown): Promise<any> {
    const base = new URL(server);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password
      || base.pathname !== "/" || base.search || base.hash || !path.startsWith("/api/v1/device-access")) {
      throw new Error("Invalid native cloud address");
    }
    if (signal.aborted) throw new Error("Native cloud request cancelled");
    const transport = base.protocol === "https:" ? https : http;
    const agent = base.protocol === "https:" ? new https.Agent() : new http.Agent();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = transport.request(new URL(path, base), {
        agent, signal, method: payload === undefined ? "GET" : "POST",
        headers: { "X-LXE-Client": "cli", ...(payload === undefined ? {} :
          { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }) },
      });
      const timer = setTimeout(() => req.destroy(new Error("Native cloud request timed out")), 10_000);
      const cleanup = () => { clearTimeout(timer); agent.destroy(); };
      req.once("error", error => { cleanup(); reject(error); });
      req.once("response", response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) req.destroy(new Error("Native cloud response exceeded 4 MiB [truncated]"));
          else chunks.push(chunk);
        });
        response.once("error", error => { cleanup(); reject(error); });
        response.once("end", () => {
          cleanup();
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // Redact named secrets before preserving diagnostics and parsing user text.
            const detail = parseCloudError(text.replace(/((?:api[_-]?key|token|secret|password|authorization|cookie)["']?\s*:\s*")[^"]*"/giu, '$1[redacted]"'));
            const fallback = status === 404 && path === "/api/v1/device-access"
              ? "公司服务器尚未支持自动云端访问，请联系管理员升级服务器。"
              : `云端访问失败（HTTP ${status}）`;
            reject(new CloudHttpError(detail, status, fallback));
            return;
          }
          try { resolve(JSON.parse(text)); }
          catch { reject(new Error("Invalid native cloud JSON response")); }
        });
      });
      req.end(payload);
    });
  }
}
