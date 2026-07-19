export interface HttpErrorObservation {
  message: string;
  httpStatus?: number;
  responseData: Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/**
 * Inspect an Axios/fetch-style thrown value without depending on an HTTP client.
 * Provider-specific code must interpret responseData itself.
 */
export function inspectHttpError(cause: unknown): HttpErrorObservation {
  const source = record(cause);
  const response = record(source.response);
  const status = Number(response.status);
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    ...(Number.isInteger(status) && status > 0 ? { httpStatus: status } : {}),
    responseData: record(response.data),
  };
}
