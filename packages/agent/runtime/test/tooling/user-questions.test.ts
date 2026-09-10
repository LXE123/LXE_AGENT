import { describe, expect, test } from "bun:test";
import { UserQuestionService, registerUserQuestionTool } from "../../src/tooling/user-questions";
import { ToolRegistry } from "../../src/tooling/registry";
import { testWorkspace } from "../workspace";

const input = { questions: [
  { id: "one", question: "Which?", options: [{ label: "A" }, { label: "B" }] },
  { id: "many", question: "Which ones?", multi_select: true, options: [{ label: "C" }, { label: "D" }] },
  { id: "text", question: "Anything else?" },
] };
const answers = [{ id: "one", selected: ["A"] }, { id: "many", selected: ["C", "D"], custom: "also E" }, { id: "text", selected: [], custom: "Details" }];
function context(session_id = "s", controller = new AbortController(), platform = "desktop") {
  return { session_id, platform, turn_id: `turn-${session_id}`, tool_call_id: `call-${session_id}`, workspace: testWorkspace,
    handle: { signal: controller.signal, get cancelled() { return controller.signal.aborted; }, drainSteering: () => [], registerProcess: () => () => {} } };
}

describe("runtime user question ownership", () => {
  test("answers only the matching call; snapshots are independent, retries settle once", async () => {
    const changes: string[] = [];
    const service = new UserQuestionService(id => changes.push(id));
    const a = service.ask(input, context("a"));
    let bDone = false;
    const b = service.ask(input, context("b")).then(value => { bDone = true; return value; });
    const [qa, qb] = service.snapshot();
    expect(qa).toMatchObject({ session_id: "a", turn_id: "turn-a", tool_call_id: "call-a" });
    const answer = { session_id: "a", request_id: qa!.request_id, answers };
    qa!.questions[0]!.id = "mutated";
    expect(service.snapshot()[0]!.questions[0]!.id).toBe("one");
    expect(() => service.submit({ ...answer, session_id: "b" })).toThrow("no longer pending");
    const ack = service.submit(answer);
    expect(service.submit(answer)).toEqual(ack);
    expect(service.submit({ ...answer, answers: [...answers].reverse().map(a => ({ ...a, selected: [...a.selected].reverse() })) })).toEqual(ack);
    expect(await a).toEqual({ answers });
    expect(bDone).toBe(false);
    expect(() => service.submit({ ...answer, answers: [{ id: "one", selected: ["B"] }, ...answers.slice(1)] })).toThrow("already answered differently");
    service.submit({ session_id: "b", request_id: qb!.request_id, answers });
    await b;
    expect(changes).toEqual(["a", "b", "a", "b"]);
    expect(service.snapshot()).toEqual([]);
  });

  test("invalid answers leave the wait active, including duplicate ids, choices and single/multi rules", async () => {
    const service = new UserQuestionService(() => {});
    const wait = service.ask(input, context());
    const request_id = service.snapshot()[0]!.request_id;
    const invalid = [[], [answers[0]], [answers[0], answers[0], answers[2]],
      [{ id: "one", selected: ["unknown"] }, ...answers.slice(1)],
      [{ id: "one", selected: ["A", "B"] }, ...answers.slice(1)],
      [{ id: "one", selected: ["A"], custom: "both" }, ...answers.slice(1)],
      [answers[0], { id: "many", selected: ["C", "C"] }, answers[2]],
      [answers[0], answers[1], { id: "text", selected: [], custom: " " }]];
    for (const value of invalid) {
      expect(() => service.submit({ session_id: "s", request_id, answers: value as typeof answers })).toThrow();
      expect(service.snapshot()).toHaveLength(1);
    }
    const custom = [{ id: "one", selected: [], custom: "My choice" }, ...answers.slice(1)];
    service.submit({ session_id: "s", request_id, answers: custom });
    expect(await wait).toEqual({ answers: custom });
  });

  test("rejects a second pending request and malformed questions without replacing the first", async () => {
    const service = new UserQuestionService(() => {});
    for (const questions of [[], [input.questions[0]!, input.questions[0]!], [{ id: "q", question: "Q", options: [{ label: "a" }, { label: "a" }] }]]) {
      await expect(service.ask({ questions }, context())).rejects.toThrow();
      expect(service.snapshot()).toHaveLength(0);
    }
    const controller = new AbortController();
    const wait = service.ask(input, context("s", controller));
    await expect(service.ask(input, context())).rejects.toThrow("already has");
    controller.abort();
    await expect(wait).rejects.toThrow("cancelled");
  });

  test.each(["cancel-first", "answer-first"])("submit/cancel race settles exactly once: %s", async order => {
    const changes: string[] = [];
    const service = new UserQuestionService(id => changes.push(id));
    const controller = new AbortController();
    const wait = service.ask(input, context("s", controller));
    const request = { session_id: "s", request_id: service.snapshot()[0]!.request_id, answers };
    if (order === "cancel-first") {
      controller.abort();
      expect(() => service.submit(request)).toThrow("no longer pending");
      await expect(wait).rejects.toThrow("cancelled");
    } else {
      service.submit(request); controller.abort();
      expect(await wait).toEqual({ answers });
      expect(() => service.submit(request)).toThrow("no longer pending");
    }
    expect(service.snapshot()).toEqual([]);
    expect(changes).toEqual(["s", "s"]);
  });

  test("delete and shutdown invalidate requests, and a fresh Agent rejects old ids", async () => {
    const service = new UserQuestionService(() => {});
    const wait = service.ask(input, context());
    const request_id = service.snapshot()[0]!.request_id;
    service.forgetSession("s");
    await expect(wait).rejects.toThrow("closed");
    const wait2 = service.ask(input, context());
    await service.stop();
    await expect(wait2).rejects.toThrow("closed");
    const fresh = new UserQuestionService(() => {});
    expect(() => fresh.submit({ session_id: "s", request_id, answers })).toThrow("no longer pending");
    expect(fresh.snapshot()).toEqual([]);
  });

  test("only desktop exposes and executes the exclusive tool, even if exposure is bypassed", async () => {
    const registry = new ToolRegistry();
    const service = new UserQuestionService(() => {});
    registerUserQuestionTool(registry, service);
    expect(registry.definition("ask_user_question")?.supportsParallelCalls).not.toBe(true);
    for (const platform of ["feishu", "cli", ""]) {
      const state = registry.createExposureState({ platform });
      expect(state.schemas()).toEqual([]);
      expect(state.search("question")).toEqual([]);
      await expect(registry.execute("ask_user_question", input, context("s", new AbortController(), platform))).rejects.toThrow("not available");
      await expect(service.ask(input, context("s", new AbortController(), platform))).rejects.toThrow("only available");
    }
    expect(registry.createExposureState({ platform: "desktop" }).schemas().map(s => s.name)).toEqual(["ask_user_question"]);
  });
});
