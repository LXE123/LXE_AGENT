import { expect, test } from "bun:test";
import { AgentRunHandle } from "../src/run-handle";

test.each([undefined, "user_stop"] as const)("the first cancellation cause (%s) survives repeated or forced stops", async reason => {
  const handle = new AgentRunHandle();
  let signals = 0;
  handle.signal.addEventListener("abort", () => { signals++; });
  await handle.abort(false, reason);
  await handle.abort(false, "user_stop");
  await handle.abort(true);
  expect(handle.cancelled).toBe(true);
  expect(handle.cancelReason).toBe(reason);
  expect(signals).toBe(1);
});
