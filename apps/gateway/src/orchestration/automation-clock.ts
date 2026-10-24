import { Worker } from "node:worker_threads";
import type { AutomationDefinition } from "@lxe/desktop-protocol";
import { nextTime } from "./automation-time";

export type AutomationTimeRequest =
  | { kind: "next"; task: AutomationDefinition; id: string; salt: string; now: number; anchor: number }
  | { kind: "preview"; task: AutomationDefinition; now: number };
export type AutomationTimeResult = ReturnType<typeof nextTime> | { times: number[]; jitter_seconds: number };

/** Recurrence libraries can loop inside one call. Keep that work off the host event loop. */
export class AutomationClock {
  private worker: Worker | undefined;
  private readonly terminations = new Set<Promise<number>>();
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private cancel: (() => void) | undefined;
  constructor(private readonly options: { workerPath?: string | URL | undefined; timeoutMs?: number } = {}) {}

  private terminate(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    const pending = worker.terminate();
    this.terminations.add(pending);
    void pending.finally(() => this.terminations.delete(pending)).catch(() => {});
  }
  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerPath ?? new URL("./automation-time-worker.ts", import.meta.url));
    this.worker = worker;
    // Retire failed idle workers too. Active requests keep their own diagnostic listeners.
    worker.on("error", () => { if (this.worker === worker) this.worker = undefined; });
    worker.on("exit", () => { if (this.worker === worker) this.worker = undefined; });
    return worker;
  }

  async next(task: AutomationDefinition, id: string, salt: string, now: number, anchor: number) {
    if (this.closed) throw new Error("Automation clock is closed");
    if (task.schedule.kind !== "rrule") return nextTime(task, id, salt, now, anchor);
    return this.request({ kind: "next", task, id, salt, now, anchor }) as Promise<ReturnType<typeof nextTime>>;
  }
  async preview(task: AutomationDefinition, now: number) {
    return this.request({ kind: "preview", task, now }) as Promise<{ times: number[]; jitter_seconds: number }>;
  }
  private request(request: AutomationTimeRequest): Promise<AutomationTimeResult> {
    const result = this.serial.then(() => this.compute(request));
    this.serial = result.catch(() => {});
    return result;
  }
  private compute(request: AutomationTimeRequest): Promise<AutomationTimeResult> {
    if (this.closed) return Promise.reject(new Error("Automation clock is closed"));
    const worker = this.getWorker();
    // Idle workers must not keep a CLI/test host alive. Active computations are awaited.
    worker.ref();
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, value?: AutomationTimeResult, terminate = false) => {
        if (finished) return;
        finished = true; clearTimeout(timer); this.cancel = undefined;
        worker.off("message", message); worker.off("error", failure); worker.off("exit", exited);
        if (terminate) this.terminate(worker); else worker.unref();
        if (error) reject(error); else resolve(value!);
      };
      const message = (response: { ok: boolean; value?: AutomationTimeResult; error?: string }) => {
        if (response.ok) finish(undefined, response.value);
        else finish(new Error(response.error ?? "Automation clock worker returned an error without diagnostics"));
      };
      const failure = (error: Error) => finish(error, undefined, true);
      const exited = (code: number) => finish(new Error(`Automation clock worker exited (${code})`), undefined, true);
      const timeout = this.options.timeoutMs ?? 1000;
      const timer = setTimeout(() => finish(new Error(`RRULE calculation exceeded ${timeout}ms; worker terminated`), undefined, true), timeout);
      this.cancel = () => finish(new Error("Automation clock closed during calculation"), undefined, true);
      worker.once("message", message); worker.once("error", failure); worker.once("exit", exited);
      try { worker.postMessage(request); } catch (error) { failure(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancel?.();
    if (this.worker) this.terminate(this.worker);
    await this.serial;
    await Promise.allSettled([...this.terminations]);
  }
}
