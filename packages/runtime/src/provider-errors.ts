import type { ProviderDescriptor } from "./provider";

export class RuntimeProviderError extends Error {
  readonly contextOverflow: boolean;
  constructor(
    message: string,
    readonly provider: string,
    readonly category: string,
    readonly userMessage: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    contextOverflow = false,
  ) {
    super(message);
    this.name = "RuntimeProviderError";
    this.contextOverflow = contextOverflow;
  }
}

const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const statusCode = (error: unknown): number | undefined => {
  const source = objectValue(error);
  const response = objectValue(source.response);
  for (const raw of [source.status, source.statusCode, source.status_code, response.status]) {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
};

const bodyText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).trim();
  try {
    return JSON.stringify(value).slice(0, 8_000).trim();
  } catch {
    return String(value).slice(0, 8_000).trim();
  }
};

const errorText = (error: unknown): string => {
  const source = objectValue(error);
  const message = String(error instanceof Error ? error.message : source.message ?? error ?? "").trim();
  const bodies = [source.body, source.error, objectValue(source.response).data]
    .map(bodyText)
    .filter(Boolean);
  return [...new Set([message, ...bodies].filter(Boolean))].join(" | ") || "provider request failed";
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
  userMessage: string;
  retryable: boolean;
  contextOverflow?: boolean;
};

const kimiClassification = (status: number, text: string): Classification => {
  const label = "Kimi Coding";
  if (contextOverflow(text)) return {
    category: "请求格式错误",
    userMessage: `${label} 上下文超过限制，已尝试压缩历史后仍无法发送，请缩短输入后重试。`,
    retryable: false,
    contextOverflow: true,
  };
  if (contains(text, "context canceled")) return {
    category: "工具调用错误", userMessage: `${label} 工具调用被取消，请稍后重试。`, retryable: true,
  };
  if (contains(text, "url2text", "spider checkurl failed", "invalid html", "image_url:moderation request error", "invalid_url", "provided url is invalid")) return {
    category: "工具调用错误", userMessage: `${label} 工具调用输入无效，请检查 URL 或图片地址。`, retryable: false,
  };
  if (contains(text, "security risk", "current url poses a security risk")) return {
    category: "工具调用错误", userMessage: `${label} 拒绝访问该 URL，当前 URL 被判定存在安全风险。`, retryable: false,
  };
  if (status === 401 || contains(text, "api key appears to be invalid", "invalid authentication", "api key", "authentication")) return {
    category: "认证错误", userMessage: `${label} 认证失败，请检查 API Key 是否无效或已过期。`, retryable: false,
  };
  if (status === 402 || contains(text, "membership benefits")) return {
    category: "会员权益异常", userMessage: `${label} 会员权益异常，请检查当前账号权益。`, retryable: false,
  };
  if (status === 404 || contains(text, "not found the model", "method not found", "not found")) return {
    category: "资源未找到", userMessage: `${label} 模型或接口未找到，请检查模型名称和账号权限。`, retryable: false,
  };
  if (contains(text, "usage limit for this billing cycle", "access terminated")) return {
    category: "权限错误", userMessage: `${label} 当前账号权限或计费周期额度不可用，请检查账号状态。`, retryable: false,
  };
  if (status === 403 || contains(text, "available for coding agents", "permission denied")) return {
    category: "权限错误", userMessage: `${label} 权限不足，请确认账号已开通 Kimi For Coding。`, retryable: false,
  };
  if (status === 429 || contains(text, "engine is currently overloaded", "receiving too many requests", "usage limit for this period", "kimi monthly usage limit", "rate limit", "too many requests")) return {
    category: "限流与配额", userMessage: `${label} 当前限流或额度不足，请稍后重试。`, retryable: true,
  };
  if (status === 400 || contains(text, "thinking is enabled but reasoning_content is missing", "unsupported image url", "function name", "is duplicated", "request was rejected", "high risk")) return {
    category: "请求格式错误", userMessage: `${label} 请求格式错误，请检查消息、工具或图片输入。`, retryable: false,
  };
  if (status >= 500 || contains(text, "bot_id", "database=membership_", "terminating connection", "failed to evaluate rate limit script", "i/o timeout", "conn closed", "bad connection", "service unavailable", "gateway timeout", "bad gateway", "未找到该账号", "该账号已被禁用", "已被禁言")) return {
    category: "服务端内部错误", userMessage: `${label} 服务暂时异常，请稍后重试。`, retryable: true,
  };
  if (status > 0) {
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    return {
      category: retryable ? "服务端内部错误" : "请求失败",
      userMessage: retryable ? `${label} 请求失败，请稍后重试。` : `${label} 请求失败，请检查请求或账号状态。`,
      retryable,
    };
  }
  return { category: "请求失败", userMessage: `${label} 请求失败，请稍后重试。`, retryable: true };
};

const deepseekClassification = (status: number, text: string): Classification => {
  const label = "DeepSeek";
  if (contextOverflow(text)) return {
    category: "格式错误",
    userMessage: `${label} 上下文超过限制，已尝试压缩历史后仍无法发送，请缩短输入后重试。`,
    retryable: false,
    contextOverflow: true,
  };
  const known: Record<number, Classification> = {
    400: { category: "格式错误", userMessage: `${label} 请求体格式错误，请根据错误信息修改请求体。`, retryable: false },
    401: { category: "认证失败", userMessage: `${label} 认证失败，请检查 API Key 是否正确。`, retryable: false },
    402: { category: "余额不足", userMessage: `${label} 账号余额不足，请确认账户余额。`, retryable: false },
    422: { category: "参数错误", userMessage: `${label} 请求参数错误，请根据错误信息修改相关参数。`, retryable: false },
    429: { category: "请求速率达到上限", userMessage: `${label} 请求速率达到上限，请稍后重试或降低请求频率。`, retryable: true },
    500: { category: "服务器故障", userMessage: `${label} 服务器内部故障，请稍后重试。`, retryable: true },
    503: { category: "服务器繁忙", userMessage: `${label} 服务器繁忙，请稍后重试。`, retryable: true },
  };
  if (known[status]) return known[status]!;
  if (status >= 500) return { category: "服务端错误", userMessage: `${label} 服务暂时异常，请稍后重试。`, retryable: true };
  if (status > 0) return { category: "请求失败", userMessage: `${label} 请求失败，请检查请求或账号状态。`, retryable: false };
  return { category: "请求失败", userMessage: `${label} 请求失败，请稍后重试。`, retryable: true };
};

const genericClassification = (status: number, text: string, label: string): Classification => {
  const overflow = contextOverflow(text);
  const auth = status === 401 || status === 403 || /auth|api key|unauthor/iu.test(text);
  const rateLimit = status === 429 || /rate.?limit|too many requests/iu.test(text);
  const retryable = !auth && !overflow && (rateLimit || status === 0 || status >= 500 || /timeout|timed out|connect|reset|overload|temporar/iu.test(text));
  if (overflow) return { category: "上下文超限", userMessage: `${label} 上下文超过模型限制，请压缩后重试。`, retryable: false, contextOverflow: true };
  if (auth) return { category: "认证错误", userMessage: `${label} 认证失败，请检查 API Key 是否正确或已过期。`, retryable: false };
  if (rateLimit) return { category: "限流", userMessage: `${label} 服务暂时异常，请稍后重试。`, retryable: true };
  return {
    category: retryable ? "服务暂时异常" : "请求错误",
    userMessage: retryable ? `${label} 服务暂时异常，请稍后重试。` : `${label} 请求失败：${text}`,
    retryable,
  };
};

export function classifyProviderError(error: unknown, descriptor: ProviderDescriptor): RuntimeProviderError {
  if (error instanceof RuntimeProviderError) return error;
  const status = statusCode(error) ?? 0;
  const rawMessage = errorText(error);
  const text = rawMessage.toLowerCase();
  const classification = descriptor.name === "kimi_coding"
    ? kimiClassification(status, text)
    : descriptor.name === "deepseek"
      ? deepseekClassification(status, text)
      : genericClassification(status, text, descriptor.name);
  return new RuntimeProviderError(
    rawMessage,
    descriptor.name,
    classification.category,
    classification.userMessage,
    classification.retryable,
    status || undefined,
    classification.contextOverflow ?? false,
  );
}
