import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { protocol } from "electron";
import { dashboardAssetContentType, resolveDashboardAsset } from "./dashboard-assets";

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
        "Content-Type": dashboardAssetContentType(asset),
        "Cache-Control": extname(asset).toLowerCase() === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  });
}
