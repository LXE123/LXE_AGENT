import type { ProviderDescriptor } from "./provider";
import { providerErrorDetails, providerErrorText, safeProviderErrorText, type ProviderErrorDetails } from "./provider-error-details";

export class RuntimeProviderError extends Error {
  readonly contextOverflow: boolean;
  readonly userMessage: string;
  constructor(
    message: string,
    readonly provider: string,
    readonly category: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    contextOverflow = false,
    readonly details: ProviderErrorDetails = {},
  ) {
    super(safeProviderErrorText(message));
    this.name = "RuntimeProviderError";
    this.contextOverflow = contextOverflow;
    const identifiers = [
      statusCode ? `HTTP ${statusCode}` : "",
      details.requestId ? `request_id: ${details.requestId}` : "",
      details.retryAfterMs === undefined ? "" : `retry_after_ms: ${details.retryAfterMs}`,
    ].filter(Boolean);
    this.userMessage = safeProviderErrorText(`${provider}${identifiers.length ? ` (${identifiers.join(", ")})` : ""}: ${this.message}`);
  }
}

const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const STATUS_KEYS = ["status", "statusCode", "status_code", "http_status"] as const;
const STATUS_CONTAINERS = ["response", "body", "error", "data"] as const;

export const providerErrorStatusCode = (error: unknown): number | undefined => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = objectValue(current.value);
    if (seen.has(source)) continue;
    seen.add(source);
    for (const key of STATUS_KEYS) {
      const value = Number(source[key]);
      if (Number.isInteger(value) && value > 0) return value;
    }
    if (current.depth >= 3) continue;
    for (const key of STATUS_CONTAINERS) {
      const child = source[key];
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
};

export const providerErrorBusinessCode = (error: unknown): number | undefined => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = objectValue(current.value);
    if (seen.has(source)) continue;
    seen.add(source);
    const code = String(source.code ?? source.error_code ?? source.errorCode ?? "").trim();
    if (/^\d{4}$/u.test(code)) return Number(code);
    if (current.depth >= 3) continue;
    for (const key of STATUS_CONTAINERS) {
      const child = source[key];
      if (child !== null && typeof child === "object" && !Array.isArray(child)) {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
};

const contains = (text: string, ...needles: string[]): boolean =>
  needles.some((needle) => text.includes(needle.toLowerCase()));

const contextOverflow = (text: string): boolean =>
  (text.includes("total message size") && text.includes("exceeds limit"))
  || text.includes("model token limit")
  || text.includes("exceeded model token limit")
  || (text.includes("request exceeded") && text.includes("token limit"))
  || contains(text, "maximum context", "context window", "context length", "too many tokens", "prompt is too long", "input is too long");

type Classification = {
  category: string;
  retryable: boolean;
  contextOverflow?: boolean;
};

const kimiClassification = (status: number, text: string): Classification => {
  if (contextOverflow(text)) return {
    category: "请求格式错误",
    retryable: false,
    contextOverflow: true,
  };
  if (contains(text, "context canceled")) return {
    category: "工具调用错误", retryable: true,
  };
  if (contains(text, "url2text", "spider checkurl failed", "invalid html", "image_url:moderation request error", "invalid_url", "provided url is invalid")) return {
    category: "工具调用错误", retryable: false,
  };
  if (contains(text, "security risk", "current url poses a security risk")) return {
    category: "工具调用错误", retryable: false,
  };
  if (contains(text, "does not have access to k3")) return {
    category: "权限错误", retryable: false,
  };
  if (contains(text, "supports only kimi-k3 up to 256k context")) return {
    category: "权限错误", retryable: false,
  };
  if (contains(text, "does not have access to kimi-for-coding-highspeed")) return {
    category: "权限错误", retryable: false,
  };
  if (status === 401 || contains(text, "api key appears to be invalid", "invalid authentication", "api key", "authentication")) return {
    category: "认证错误", retryable: false,
  };
  if (status === 402 || contains(text, "membership benefits")) return {
    category: "会员权益异常", retryable: true,
  };
  if (status === 404 || contains(text, "not found the model", "method not found", "not found")) return {
    category: "资源未找到", retryable: false,
  };
  if (contains(text, "usage limit for this billing cycle", "access terminated")) return {
    category: "权限错误", retryable: false,
  };
  if (status === 403 || contains(text, "available for coding agents", "permission denied")) return {
    category: "权限错误", retryable: false,
  };
  if (status === 429 || contains(text, "engine is currently overloaded", "receiving too many requests", "usage limit for this period", "kimi monthly usage limit", "rate limit", "too many requests")) return {
    category: "限流与配额", retryable: true,
  };
  if (status === 400 || contains(text, "thinking is enabled but reasoning_content is missing", "unsupported image url", "function name", "is duplicated", "request was rejected", "high risk")) return {
    category: "请求格式错误", retryable: false,
  };
  if (status >= 500 || contains(text, "bot_id", "database=membership_", "terminating connection", "failed to evaluate rate limit script", "i/o timeout", "conn closed", "bad connection", "service unavailable", "gateway timeout", "bad gateway", "未找到该账号", "该账号已被禁用", "已被禁言")) return {
    category: "服务端内部错误", retryable: true,
  };
  if (status > 0) {
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    return {
      category: retryable ? "服务端内部错误" : "请求失败",
      retryable,
    };
  }
  return { category: "请求失败", retryable: true };
};

const deepseekClassification = (status: number, text: string): Classification => {
  if (status === 413 || text.includes("failed to buffer the request body: length limit exceeded")) return {
    category: "请求体过大", retryable: false,
  };
  if (contextOverflow(text)) return {
    category: "格式错误",
    retryable: false,
    contextOverflow: true,
  };
  const known: Record<number, Classification> = {
    400: { category: "格式错误", retryable: false },
    401: { category: "认证失败", retryable: false },
    402: { category: "余额不足", retryable: false },
    422: { category: "参数错误", retryable: false },
    429: { category: "请求速率达到上限", retryable: true },
    500: { category: "服务器故障", retryable: true },
    503: { category: "服务器繁忙", retryable: true },
  };
  if (known[status]) return known[status]!;
  if (status >= 500) return { category: "服务端错误", retryable: true };
  if (status > 0) return { category: "请求失败", retryable: false };
  return { category: "请求失败", retryable: true };
};

const zhipuClassification = (
  status: number,
  businessCode: number,
  text: string,
): Classification => {
  if (businessCode === 1261 || contextOverflow(text)) return {
    category: "上下文超限",
    retryable: false,
    contextOverflow: true,
  };
  if ([1000, 1001, 1003].includes(businessCode) || (status === 401 && businessCode === 0)) return {
    category: "认证失败",
    retryable: false,
  };
  if (businessCode === 1005) return {
    category: "账号安全限制",
    retryable: false,
  };
  if (businessCode === 1113) return {
    category: "余额不足",
    retryable: false,
  };
  if ([1210, 1212, 1213, 1214, 1215, 1221, 1222].includes(businessCode)) return {
    category: "请求参数错误",
    retryable: false,
  };
  if (businessCode === 1211) return {
    category: "模型不存在",
    retryable: false,
  };
  if (businessCode === 1220 || [1309, 1311, 1314, 1315].includes(businessCode)) return {
    category: "权限错误",
    retryable: false,
  };
  if (businessCode === 1301) return {
    category: "内容安全限制",
    retryable: false,
  };
  if ([1304, 1308, 1310, 1313, 1316, 1317, 1318, 1319, 1320, 1321].includes(businessCode)) return {
    category: "套餐额度限制",
    retryable: false,
  };
  if (businessCode === 1302) return {
    category: "请求限流",
    retryable: true,
  };
  if (businessCode === 1305) return {
    category: "服务繁忙",
    retryable: true,
  };
  if ([1200, 1230, 1234].includes(businessCode) || status >= 500) return {
    category: "服务端错误",
    retryable: true,
  };
  if (status === 403) return {
    category: "权限错误",
    retryable: false,
  };
  if (status === 429) return {
    category: "请求限流",
    retryable: true,
  };
  if (status === 400 || status === 422) return {
    category: "请求参数错误",
    retryable: false,
  };
  return genericClassification(status, text);
};

const genericClassification = (status: number, text: string): Classification => {
  const overflow = contextOverflow(text);
  const auth = status === 401 || status === 403 || /auth|api key|unauthor/iu.test(text);
  const rateLimit = status === 429 || /rate.?limit|too many requests/iu.test(text);
  const retryable = !auth && !overflow && (rateLimit || status === 0 || status >= 500 || /timeout|timed out|connect|reset|overload|temporar/iu.test(text));
  if (overflow) return { category: "上下文超限", retryable: false, contextOverflow: true };
  if (auth) return { category: "认证错误", retryable: false };
  if (rateLimit) return { category: "限流", retryable: true };
  return {
    category: retryable ? "服务暂时异常" : "请求错误",
    retryable,
  };
};

// OpenAI distinguishes persistent billing/access failures from temporary HTTP
// throttling. Stream errors have no HTTP status: use their code/type too.
const openaiClassification = (status: number, text: string, details: ProviderErrorDetails): Classification => {
  const codes = new Set([details.code, details.type]);
  const matches = (...values: string[]) => values.some(value => codes.has(value));
  if (matches("context_length_exceeded") || contextOverflow(text)) return { category: "上下文超限", retryable: false, contextOverflow: true };
  if (matches("insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded",
    "subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded")) {
    return { category: "额度限制", retryable: false };
  }
  if (details.incompleteReason || matches("content_filter", "content_policy_violation")) return { category: "回复未完成", retryable: false };
  if (status === 401 || matches("invalid_api_key", "authentication_error")) return { category: "认证错误", retryable: false };
  if (status === 403 || matches("permission_denied", "unsupported_country_region_territory")) return { category: "权限错误", retryable: false };
  // Older responses can pair rate_limit_exceeded with invalid_request_error.
  if (matches("rate_limit_exceeded", "slow_down")) return { category: "限流", retryable: true };
  if (matches("invalid_request_error", "model_not_found")) return { category: "请求错误", retryable: false };
  if (status === 429 || matches("rate_limit_error", "rate_limit_exceeded", "slow_down")) return { category: "限流", retryable: true };
  if ([408, 409].includes(status) || status >= 500 || matches("server_error", "internal_error", "server_is_overloaded", "service_unavailable_error",
    "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable")) return { category: "服务暂时异常", retryable: true };
  if (status > 0) return { category: "请求错误", retryable: false };
  const transient = /connection error|connection (?:reset|lost|refused)|socket|fetch failed|network|econnreset|econnrefused|enotfound|eai_again|etimedout|timed? out|timeout|stream ended before a terminal response event/iu.test(text);
  return { category: transient ? "连接错误" : "请求错误", retryable: transient };
};

export function classifyProviderError(error: unknown, descriptor: ProviderDescriptor): RuntimeProviderError {
  if (error instanceof RuntimeProviderError) return error;
  const status = providerErrorStatusCode(error) ?? 0;
  const parsedBusinessCode = providerErrorBusinessCode(error);
  const rawMessage = providerErrorText(error);
  const details = providerErrorDetails(error);
  const secrets = [descriptor.apiKey, ...Object.entries(descriptor.defaultHeaders)
    .filter(([name]) => /authorization|api[_-]?key|token|cookie|secret/iu.test(name))
    .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/iu, "")])];
  const text = rawMessage.toLowerCase();
  const businessCode = parsedBusinessCode
    ?? Number(text.match(/(?:"code"|code)\s*[:=]\s*"?(\d{4})/u)?.[1] ?? 0);
  const classification = descriptor.name === "kimi_coding"
    ? kimiClassification(status, text)
    : descriptor.name === "deepseek"
      ? deepseekClassification(status, text)
      : descriptor.name === "zhipuai" || descriptor.name === "zhipuai_coding_plan"
        ? zhipuClassification(
          status,
          businessCode,
          text,
        )
      : descriptor.name === "openai"
        ? openaiClassification(status, text, details)
        : genericClassification(status, text);
  return new RuntimeProviderError(
    safeProviderErrorText(rawMessage, secrets),
    descriptor.name,
    classification.category,
    classification.retryable,
    status || undefined,
    classification.contextOverflow ?? false,
    Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === "string" ? safeProviderErrorText(value, secrets) : value])),
  );
}
