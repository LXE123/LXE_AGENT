import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { sanitizeLogValueWithPolicy } from "@lxe/core";

export const mapping = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const stringMapping = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(mapping(value)).map(([key, item]) => [key, String(item ?? "")]));

/** Match Pi's HTTP startup retry policy using actual error types, never message text. */
export const isTransientMcpHttpError = (error: unknown): boolean => {
  if (error instanceof SdkHttpError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
  }
  // The SDK wraps a failed server/discover fetch, but preserves the network cause.
  if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed) {
    return error.cause instanceof TypeError;
  }
  return error instanceof TypeError;
};

export const mcpFailureText = (error: unknown): string => {
  let observed = error instanceof Error ? error.message : String(error);
  if (error instanceof ProtocolError || error instanceof SdkError) {
    // v2 HTTP/protocol failures can keep the upstream diagnostic in data,
    // while message contains only the status or a short protocol summary.
    const details = sanitizeLogValueWithPolicy({ code: error.code, data: error.data }, { maxString: 2_000 });
    observed += `\n${JSON.stringify(details)}`;
  }
  return String(sanitizeLogValueWithPolicy(observed, { maxString: 2_000 }));
};

export const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parent?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent?.reason ?? new DOMException("Cancelled", "AbortError"));
  parent?.throwIfAborted();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("Cancelled", "AbortError"),
    ), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
};
