import { setTimeout as sleep } from "node:timers/promises";
import { RuntimeProviderError } from "./provider-errors";

export const MAX_PROVIDER_RETRY_DELAY_MS = 60_000;

/** Undefined means stop; never shorten the server's minimum wait to our cap. */
export function providerRetryDelayMs(error: unknown, attempt: number, random = Math.random): number | undefined {
  if (error instanceof RuntimeProviderError && !error.retryable) return undefined;
  const serverDelay = error instanceof RuntimeProviderError ? error.details.retryAfterMs : undefined;
  if (serverDelay !== undefined && serverDelay > MAX_PROVIDER_RETRY_DELAY_MS) return undefined;
  const delay = Math.max(serverDelay ?? 0, Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_PROVIDER_RETRY_DELAY_MS));
  return Math.min(MAX_PROVIDER_RETRY_DELAY_MS, delay + random() * delay * 0.25);
}

export async function waitForProviderRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await sleep(delayMs, undefined, { signal });
}
