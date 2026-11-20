/** Capacity belongs to the agent-cli process, across registries, sessions and turns. */
const waiting = new Set<() => void>();
let occupied = 0;
const MAX_QUEUE_WAIT_MS = 60_000;

function workerLimit(): number {
  const limit = Number(process.env.PI_CODEMODE_MAX_WORKERS);
  return Number.isInteger(limit) && limit > 0 ? limit : 2;
}

function admitWaiting(): void {
  const limit = workerLimit();
  for (const grant of waiting) {
    if (occupied >= limit) break;
    waiting.delete(grant);
    occupied++;
    grant();
  }
}

function releaseWorker(): void {
  occupied--;
  admitWaiting();
}

interface WorkerSlot {
  timeoutMs: number;
  acquireWorker(): () => void;
}

export async function withCodemodeWorker<T>(
  signal: AbortSignal,
  timeoutMs: number | undefined,
  run: (slot: WorkerSlot) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const budget = timeoutMs ?? Infinity;
  const deadline = performance.now() + budget;
  const slot = Promise.withResolvers<void>();
  const onAbort = () => {
    if (waiting.delete(slot.resolve)) {
      const reason = signal.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      slot.reject(new Error(`Script aborted while waiting for a codemode worker: ${message}. The script did not start.`));
    }
  };
  const timer = setTimeout(() => {
    if (!waiting.delete(slot.resolve)) return;
    const reason = budget <= MAX_QUEUE_WAIT_MS
      ? `Execution timed out after ${budget} ms while waiting for a free codemode worker.`
      : "No codemode worker became free within 60 seconds.";
    slot.reject(new Error(`${reason} The script did not start.`));
  }, Math.min(budget, MAX_QUEUE_WAIT_MS));
  signal.addEventListener("abort", onAbort, { once: true });
  waiting.add(slot.resolve);
  admitWaiting();
  try {
    await slot.promise;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }

  let reserved = true;
  try {
    signal.throwIfAborted();
    return await run({
      timeoutMs: Math.max(1, Math.round(deadline - performance.now())),
      acquireWorker() {
        if (!reserved) throw new Error("The codemode worker reservation is no longer available.");
        // Pi calls the returned function on construction failure or actual worker exit.
        reserved = false;
        return releaseWorker;
      },
    });
  } finally {
    if (reserved) {
      reserved = false;
      releaseWorker();
    }
  }
}
