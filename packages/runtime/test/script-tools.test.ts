import { describe, expect, test } from "bun:test";
import { PythonScriptToolRunner, registerScriptTools } from "../src/script-tools";
import { ToolRegistry } from "../src/tools";

describe("Python JSON tool bridge", () => {
  test("writes one request, accepts one response, and keeps stderr outside protocol", async () => {
    const code = [
      "import json,sys",
      "request=json.loads(sys.stdin.read())",
      "print('diagnostic', file=sys.stderr)",
      "print(json.dumps({'protocol_version':'1','call_id':request['call_id'],'ok':True,'content':[{'type':'text','text':request['arguments']['value']}]}))",
    ].join(";");
    const stderr: string[] = [];
    const runner = new PythonScriptToolRunner({
      command: ["uv", "run", "--frozen", "python", "-c", code],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxOutputBytes: 64_000,
      onStderr: (line) => stderr.push(line),
    });
    const response = await runner.execute({
      protocol_version: "1",
      call_id: "call-1",
      tool_name: "fixture",
      arguments: { value: "中文😀" },
      session: { session_id: "s1", response_route_id: "r1", user_id: "u1", conversation_id: "c1" },
    }, new AbortController().signal);
    expect(response).toEqual(expect.objectContaining({ ok: true, call_id: "call-1" }));
    expect(response.content[0]?.text).toBe("中文😀");
    expect(stderr.join("\n")).toContain("diagnostic");
  });

  test("registers script schemas and translates runtime context into one protocol request", async () => {
    const requests: unknown[] = [];
    const registry = new ToolRegistry();
    registerScriptTools(registry, {
      definitions: [{ name: "py_demo", description: "demo", input_schema: { type: "object" } }],
      session: async (sessionId) => ({ session_id: sessionId, response_route_id: "route", user_id: "user", conversation_id: "chat" }),
      runner: {
        execute: async (request) => {
          requests.push(request);
          return { protocol_version: "1", call_id: request.call_id, ok: true, content: [{ type: "text", text: "ok" }] };
        },
      },
    });
    const output = await registry.execute("py_demo", { value: 1 }, {
      session_id: "session",
      handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
    });
    expect(output.content[0]?.text).toBe("ok");
    expect(requests[0]).toMatchObject({ protocol_version: "1", tool_name: "py_demo", arguments: { value: 1 }, session: { session_id: "session" } });
  });
});
