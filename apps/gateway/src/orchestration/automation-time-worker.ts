import { parentPort } from "node:worker_threads";
import type { AutomationTimeRequest } from "./automation-clock";
import { jitterSeconds, nextNominal, nextTime } from "./automation-time";

parentPort!.on("message", (request: AutomationTimeRequest) => {
  try {
    if (request.kind === "next") {
      parentPort!.postMessage({ ok: true, value: nextTime(request.task, request.id, request.salt, request.now, request.anchor) });
    } else {
      const times: number[] = [];
      let cursor = request.now;
      for (let i = 0; i < 5; i++) {
        const next = nextNominal(request.task, cursor, request.now);
        if (next === null) break;
        times.push(next); cursor = next;
      }
      parentPort!.postMessage({ ok: true, value: { times, jitter_seconds: jitterSeconds(request.task) } });
    }
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
