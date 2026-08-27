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
  if (contains(text, "does not have access to k3")) return {
    category: "权限错误", userMessage: `${label} 当前会员套餐不支持 K3，请升级套餐或改用 kimi-for-coding。`, retryable: false,
  };
  if (contains(text, "supports only kimi-k3 up to 256k context")) return {
    category: "权限错误", userMessage: `${label} 当前会员套餐的 K3 上下文上限为 256K，请缩短上下文或升级套餐。`, retryable: false,
  };
  if (contains(text, "does not have access to kimi-for-coding-highspeed")) return {
    category: "权限错误", userMessage: `${label} 当前会员套餐不支持 HighSpeed，请升级套餐或改用 kimi-for-coding。`, retryable: false,
  };
  if (status === 401 || contains(text, "api key appears to be invalid", "invalid authentication", "api key", "authentication")) return {
    category: "认证错误", userMessage: `${label} 认证失败，请检查 API Key 是否无效或已过期。`, retryable: false,
  };
  if (status === 402 || contains(text, "membership benefits")) return {
    category: "会员权益异常", userMessage: `${label} 暂时无法验证会员权益，请稍后重试。`, retryable: true,
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

const zhipuClassification = (
  status: number,
  businessCode: number,
  text: string,
  label: string,
): Classification => {
  if (businessCode === 1261 || contextOverflow(text)) return {
    category: "上下文超限",
    userMessage: `${label} 上下文超过模型限制，已尝试压缩历史后仍无法发送，请缩短输入后重试。`,
    retryable: false,
    contextOverflow: true,
  };
  if ([1000, 1001, 1003].includes(businessCode) || (status === 401 && businessCode === 0)) return {
    category: "认证失败",
    userMessage: `${label} 认证失败，请检查 API Key 是否正确或已过期。`,
    retryable: false,
  };
  if (businessCode === 1005) return {
    category: "账号安全限制",
    userMessage: `${label} 账号已开启二次认证保护，请先处理账号安全验证。`,
    retryable: false,
  };
  if (businessCode === 1113) return {
    category: "余额不足",
    userMessage: `${label} 账号余额不足，请充值或确认当前 API Key 对应的计费方式。`,
    retryable: false,
  };
  if ([1210, 1212, 1213, 1214, 1215, 1221, 1222].includes(businessCode)) return {
    category: "请求参数错误",
    userMessage: `${label} 请求参数或调用方式不受支持，请检查模型与请求配置。`,
    retryable: false,
  };
  if (businessCode === 1211) return {
    category: "模型不存在",
    userMessage: `${label} 模型不存在，请检查模型名称或客户端模型目录。`,
    retryable: false,
  };
  if (businessCode === 1220 || [1309, 1311, 1314, 1315].includes(businessCode)) return {
    category: "权限错误",
    userMessage: `${label} 当前账号、套餐或 API Key 无权使用该接口或模型。`,
    retryable: false,
  };
  if (businessCode === 1301) return {
    category: "内容安全限制",
    userMessage: `${label} 拒绝了可能包含不安全或敏感内容的请求。`,
    retryable: false,
  };
  if ([1304, 1308, 1310, 1313, 1316, 1317, 1318, 1319, 1320, 1321].includes(businessCode)) return {
    category: "套餐额度限制",
    userMessage: `${label} 当前套餐额度或使用上限已达到，请等待额度刷新或调整套餐。`,
    retryable: false,
  };
  if (businessCode === 1302) return {
    category: "请求限流",
    userMessage: `${label} 请求频率达到上限，请稍后重试。`,
    retryable: true,
  };
  if (businessCode === 1305) return {
    category: "服务繁忙",
    userMessage: `${label} 当前模型访问量过大，请稍后重试。`,
    retryable: true,
  };
  if ([1200, 1230, 1234].includes(businessCode) || status >= 500) return {
    category: "服务端错误",
    userMessage: `${label} 服务暂时异常，请稍后重试。`,
    retryable: true,
  };
  if (status === 403) return {
    category: "权限错误",
    userMessage: `${label} 权限不足，请检查账号、套餐和接口权限。`,
    retryable: false,
  };
  if (status === 429) return {
    category: "请求限流",
    userMessage: `${label} 当前限流，请稍后重试。`,
    retryable: true,
  };
  if (status === 400 || status === 422) return {
    category: "请求参数错误",
    userMessage: `${label} 请求格式错误，请检查模型、消息和工具参数。`,
    retryable: false,
  };
  return genericClassification(status, text, label);
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
  const status = providerErrorStatusCode(error) ?? 0;
  const parsedBusinessCode = providerErrorBusinessCode(error);
  const rawMessage = errorText(error);
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
          descriptor.name === "zhipuai_coding_plan" ? "Zhipu AI Coding Plan" : "Zhipu AI",
        )
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
