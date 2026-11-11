import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { withCodemodeWorker } from "../src/codemode-workers";

const signal = new AbortController().signal;
let previousLimit: string | undefined;

beforeEach(() => {
  previousLimit = process.env.PI_CODEMODE_MAX_WORKERS;
  process.env.PI_CODEMODE_MAX_WORKERS = "1";
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  if (previousLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
  else process.env.PI_CODEMODE_MAX_WORKERS = previousLimit;
});

test("a settled script occupies its slot until worker exit, and waiting consumes the next script's budget", async () => {
  const exitWorker = await withCodemodeWorker(signal, undefined, async slot => slot.acquireWorker());
  const next = withCodemodeWorker(signal, 2_000, async slot => slot.timeoutMs);
  jest.advanceTimersByTime(750);
  exitWorker();
  expect(await next).toBe(1_250);
});

test("waiting is capped at 60 seconds even with a longer or unlimited execution budget", async () => {
  const exitWorker = await withCodemodeWorker(signal, undefined, async slot => slot.acquireWorker());
  let started = false;
  try {
    const pending = [undefined, 90_000].map(budget => withCodemodeWorker(signal, budget, async () => {
      started = true;
    }).catch(error => String(error)));
    jest.advanceTimersByTime(60_000);
    for (const outcome of await Promise.all(pending)) expect(outcome).toMatch(/60 seconds.*did not start/i);
  } finally {
    exitWorker();
  }
  expect(started).toBe(false);
  expect(await withCodemodeWorker(signal, undefined, async slot => slot.timeoutMs)).toBe(Infinity);
});

test("failure before worker launch releases the reservation and prevents a late launch", async () => {
  let lateLaunch: (() => () => void) | undefined;
  await expect(withCodemodeWorker(signal, undefined, async slot => {
    lateLaunch = slot.acquireWorker;
    throw new Error("failed to read script state");
  })).rejects.toThrow("failed to read script state");
  expect(() => lateLaunch!()).toThrow("reservation is no longer available");
  expect(await withCodemodeWorker(signal, 1_000, async slot => slot.timeoutMs)).toBe(1_000);
});
