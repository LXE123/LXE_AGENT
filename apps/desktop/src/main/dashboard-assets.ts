import { existsSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const DASHBOARD_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export type DashboardAssetResolution =
  | { status: 200; path: string }
  | { status: 400 | 404 | 503 };

export const dashboardAssetContentType = (path: string): string =>
  DASHBOARD_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const safeAssetPath = (root: string, decodedPathname: string): string | undefined => {
  const candidate = resolve(root, `.${decodedPathname}`);
  const relation = relative(resolve(root), candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) return undefined;
  return candidate;
};

/** Resolve static files and extensionless SPA routes without exposing the filesystem. */
export function resolveDashboardAsset(root: string, pathname: string): DashboardAssetResolution {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }
  if (decodedPathname === "/api" || decodedPathname.startsWith("/api/")) {
    return { status: 404 };
  }
  const requested = safeAssetPath(root, decodedPathname);
  if (!requested) return { status: 400 };
  if (existsSync(requested) && statSync(requested).isFile()) return { status: 200, path: requested };
  if (extname(requested)) return { status: 404 };
  const index = join(root, "index.html");
  return existsSync(index) && statSync(index).isFile()
    ? { status: 200, path: index }
    : { status: 503 };
}
