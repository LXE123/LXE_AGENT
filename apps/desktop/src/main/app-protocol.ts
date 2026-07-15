import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { protocol } from "electron";
import { resolveDashboardAsset } from "./dashboard-assets";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function registerDashboardProtocol(dashboardRoot: string): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    if (url.host !== "lxe") return new Response("Not found", { status: 404 });
    const resolution = resolveDashboardAsset(dashboardRoot, url.pathname);
    if (resolution.status !== 200) {
      const message = resolution.status === 400
        ? "Bad request"
        : resolution.status === 404
          ? "Not found"
          : "Dashboard is not built";
      return new Response(message, { status: resolution.status });
    }
    const asset = resolution.path;
    return new Response(readFileSync(asset), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[extname(asset).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": extname(asset).toLowerCase() === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  });
}
