import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { encodePipeFrame, readFrame, requestDesktopPipe } from "../src/local-pipe";
import { startDesktopPipe } from "../src/local-pipe-server";

test("progress frames can arrive split or coalesced while requests still accept only one frame", async () => {
  const received: unknown[] = [], stream = new PassThrough();
  readFrame(stream as unknown as Socket, value => received.push(value), true);
  const frames = Buffer.concat([encodePipeFrame({ progress: "one" }), encodePipeFrame({ progress: "two" }), encodePipeFrame({ result: "done" })]);
  stream.write(frames.subarray(0, 2));
  stream.write(frames.subarray(2, 10));
  expect(received).toEqual([]);
  stream.write(frames.subarray(10));
  expect(received).toEqual([{ progress: "one" }, { progress: "two" }, { result: "done" }]);
  stream.destroy();

  for (const invalid of [frames, Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0x10, 0, 1])]) {
    const request = new PassThrough();
    const failed = new Promise<Error>(resolve => request.once("error", resolve));
    readFrame(request as unknown as Socket, () => { throw new Error("must not accept an invalid request"); });
    request.write(invalid);
    expect((await failed).message).toMatch(/extra.*frame|Invalid.*length/);
  }
});

test("authenticated requests stream opt-in progress before completion and preserve final errors", async () => {
  const reported = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  const pipe = await startDesktopPipe({ token: "fixture-secret", call: async (method, _params, _signal, progress) => {
    calls++;
    progress({ stage: "authorize" });
    if (method === "pause") await release.promise;
    if (method === "fail") throw new Error("actual failure after progress");
    progress({ stage: "saved" });
    return "connected";
  } });
  const events: unknown[] = [];
  const request = requestDesktopPipe(pipe.path, "fixture-secret", "pause", {}, undefined, 2_000, value => { events.push(value); reported.resolve(); });
  try {
    await reported.promise;
    expect(events).toEqual([{ stage: "authorize" }]);
    release.resolve();
    expect(await request).toBe("connected");
    expect(events).toEqual([{ stage: "authorize" }, { stage: "saved" }]);
    // Existing single-response callers opt out of progress and continue to work.
    expect(await requestDesktopPipe(pipe.path, "fixture-secret", "plain", {})).toBe("connected");
    const failedEvents: unknown[] = [];
    await expect(requestDesktopPipe(pipe.path, "fixture-secret", "fail", {}, undefined, 2_000, value => failedEvents.push(value))).rejects.toThrow("actual failure after progress");
    expect(failedEvents).toEqual([{ stage: "authorize" }]);
    await expect(requestDesktopPipe(pipe.path, "wrong-token", "plain", {}, undefined, 2_000, () => { throw new Error("unauthenticated progress"); })).rejects.toThrow("authentication failed");
    expect(calls).toBe(3);
  } finally { release.resolve(); await pipe.close(); }
});
