import type {
  DashboardTransportRequest,
  DesktopSetupInput,
} from "@lxe/desktop-protocol";

const GET_PATHS = [
  /^\/api\/sessions(?:\/[^/?#]+)?$/u,
  /^\/api\/skills(?:\/[^/?#]+(?:\/content|\/references\/[^?#]+)?)?$/u,
  /^\/api\/commands$/u,
  /^\/api\/project-docs(?:\/[^?#]+)?$/u,
  /^\/api\/connectors$/u,
  /^\/api\/tools\/toolsets$/u,
  /^\/api\/mcp\/servers$/u,
  /^\/api\/background-tasks$/u,
  /^\/api\/stats\/(?:overview|skills(?:\/[^/?#]+)?|tools)$/u,
  /^\/api\/models(?:\/current)?$/u,
  /^\/api\/channels\/health$/u,
];
const PATCH_PATHS = [
  /^\/api\/connectors\/[^/?#]+$/u,
  /^\/api\/mcp\/servers\/[^/?#]+$/u,
  /^\/api\/models\/current(?:\/thinking)?$/u,
];

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const boundedText = (value: unknown, label: string, maximum: number): string => {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > maximum) throw new Error(`${label} is too long`);
  return value.trim();
};

export function validateDashboardRequest(value: unknown): DashboardTransportRequest {
  const request = objectValue(value, "Dashboard request");
  const method = String(request.method ?? "").toUpperCase();
  if (method !== "GET" && method !== "PATCH") throw new Error("Dashboard method is not allowed");
  const rawPath = boundedText(request.path, "Dashboard path", 8_192);
  const url = new URL(rawPath, "http://desktop.lxe");
  if (url.origin !== "http://desktop.lxe") throw new Error("Dashboard origin is not allowed");
  const patterns = method === "GET" ? GET_PATHS : PATCH_PATHS;
  if (!patterns.some((pattern) => pattern.test(url.pathname))) {
    throw new Error(`Dashboard path is not allowed: ${url.pathname}`);
  }
  if (method === "GET" && request.body !== undefined) throw new Error("GET requests cannot contain a body");
  const body = request.body;
  if (body !== undefined) objectValue(body, "Dashboard request body");
  if (body !== undefined && JSON.stringify(body).length > 1_000_000) {
    throw new Error("Dashboard request body is too large");
  }
  return {
    method,
    path: `${url.pathname}${url.search}`,
    ...(body === undefined ? {} : { body }),
  } as DashboardTransportRequest;
}

export function validateSetupInput(value: unknown): DesktopSetupInput {
  const input = objectValue(value, "Desktop setup input");
  const provider = boundedText(input.provider, "Model provider", 64);
  if (provider !== "kimi_coding" && provider !== "deepseek" && provider !== "glm") {
    throw new Error("Unsupported model provider");
  }
  const workspaceRoot = boundedText(input.workspace_root, "Workspace", 32_768);
  if (!workspaceRoot) throw new Error("Workspace is required");
  const apiKey = boundedText(input.api_key, "Model API key", 16_384);
  const feishuAppId = boundedText(input.feishu_app_id, "Feishu App ID", 1_024);
  const feishuAppSecret = boundedText(input.feishu_app_secret, "Feishu App Secret", 16_384);
  return {
    provider,
    workspace_root: workspaceRoot,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(feishuAppId ? { feishu_app_id: feishuAppId } : {}),
    ...(feishuAppSecret ? { feishu_app_secret: feishuAppSecret } : {}),
  };
}
