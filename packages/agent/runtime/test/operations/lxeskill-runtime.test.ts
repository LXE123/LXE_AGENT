import { describe, expect, test } from "bun:test";
import { LxeSkillRuntimeService } from "../../src/operations/lxeskill-runtime";
import type { CliTerminalResult } from "../../src/tooling/one-shot-cli";
import { ToolRegistry } from "../../src/tooling/registry";

const listResult = (): CliTerminalResult => ({
  protocol_version: "1",
  type: "result",
  command: "list",
  ok: true,
  data: { commands: [] },
  files: [],
});

describe("LxeSkillRuntimeService", () => {
  test("marks the runtime ready before starting its dependent service", async () => {
    const order: string[] = [];
    const service = new LxeSkillRuntimeService({
      runner: { execute: async (arguments_) => {
        expect(arguments_).toEqual(["list"]);
        order.push("probe");
        return listResult();
      } },
      dependentService: {
        start: async () => { order.push("dependent"); },
        stop: async () => { order.push("stop"); },
      },
      recovery: "repair runtime",
    });

    await service.start(new ToolRegistry());

    expect(order).toEqual(["probe", "dependent"]);
    expect(service.snapshot()).toEqual({
      state: "ready",
      available: true,
      message: "",
      recovery: "",
    });
    await service.stop();
    expect(order).toEqual(["probe", "dependent", "stop"]);
  });

  test("degrades without starting dependent work when the probe fails", async () => {
    let dependentStarts = 0;
    const service = new LxeSkillRuntimeService({
      runner: { execute: async () => {
        throw new Error("No module named lxeskill");
      } },
      dependentService: {
        start: async () => { dependentStarts += 1; },
        stop: async () => undefined,
      },
      recovery: "run uv sync",
    });

    await expect(service.start(new ToolRegistry())).resolves.toBeUndefined();

    expect(dependentStarts).toBe(0);
    expect(service.snapshot()).toMatchObject({
      state: "unavailable",
      available: false,
      recovery: "run uv sync",
    });
    expect(service.snapshot().message).toContain("No module named lxeskill");
    expect(service.snapshot().message).toContain("run uv sync");
  });

  test("cleans up a dependent startup failure and allows a later retry", async () => {
    let starts = 0;
    let stops = 0;
    const service = new LxeSkillRuntimeService({
      runner: { execute: async () => listResult() },
      dependentService: {
        start: async () => {
          starts += 1;
          if (starts === 1) throw new Error("maintenance failed");
        },
        stop: async () => { stops += 1; },
      },
      recovery: "repair runtime",
    });

    await expect(service.start(new ToolRegistry())).rejects.toThrow("maintenance failed");
    expect(stops).toBe(1);

    await service.start(new ToolRegistry());
    expect(starts).toBe(2);
    expect(service.snapshot().available).toBe(true);
    await service.stop();
    expect(stops).toBe(2);
  });
});
