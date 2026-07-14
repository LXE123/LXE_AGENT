import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonScriptToolRunner, loadLxeSkillCommandCatalog, loadScriptToolCatalog, registerScriptTools } from "../src/script-tools";
import { ToolRegistry } from "../src/tools";

describe("Python JSON tool bridge", () => {
  test("timeout terminates the complete Windows child process tree", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(join(tmpdir(), "lxe-script-tree-"));
    const childPidPath = join(root, "child.pid");
    const code = [
      "import pathlib,subprocess,sys,time",
      `child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])`,
      `pathlib.Path(${JSON.stringify(childPidPath)}).write_text(str(child.pid),encoding='utf-8')`,
      "time.sleep(60)",
    ].join(";");
    const runner = new PythonScriptToolRunner({
      command: [join(process.cwd(), ".venv", "Scripts", "python.exe"), "-c", code],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 64_000,
    });
    let childPid = 0;
    try {
      await expect(runner.execute({
        protocol_version: "1",
        call_id: "timeout-tree",
        tool_name: "fixture",
        arguments: {},
        session: { session_id: "s1", response_route_id: "r1", user_id: "u1", conversation_id: "c1" },
      }, new AbortController().signal)).rejects.toThrow();
      childPid = Number(readFileSync(childPidPath, "utf8"));
      await Bun.sleep(100);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (childPid > 0) {
        try {
          process.kill(childPid, 0);
          const taskkill = Bun.which("taskkill");
          if (taskkill) await Bun.spawn([taskkill, "/PID", String(childPid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
        } catch {
          // Already gone.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const root = mkdtempSync(join(tmpdir(), "lxe-script-files-"));
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "result.txt"), "ok", "utf8");
    registerScriptTools(registry, {
      definitions: [{ name: "py_demo", description: "demo", input_schema: { type: "object" }, timeoutMs: 1_234 }],
      projectRoot: root,
      session: async (sessionId) => ({ session_id: sessionId, response_route_id: "route", user_id: "user", conversation_id: "chat" }),
      runner: {
        execute: async (request, _signal, timeoutMs) => {
          requests.push({ request, timeoutMs });
          return {
            protocol_version: "1", call_id: request.call_id, ok: true,
            content: [{ type: "text", text: "ok" }], files: ["artifacts/result.txt"],
          };
        },
      },
    });
    const output = await registry.execute("py_demo", { value: 1 }, {
      session_id: "session",
      response_route_id: "route-current",
      handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => undefined },
    });
    expect(output.content[0]?.text).toBe("ok");
    const outputFiles = output.files ?? [];
    expect(outputFiles).toHaveLength(1);
    expect(realpathSync(outputFiles[0]!)).toBe(realpathSync(join(root, "artifacts", "result.txt")));
    expect(requests[0]).toMatchObject({
      timeoutMs: 1_234,
      request: {
        protocol_version: "1", tool_name: "py_demo", arguments: { value: 1 },
        session: { session_id: "session", response_route_id: "route-current" },
      },
    });
    rmSync(root, { recursive: true, force: true });
  });

  test("loads the shared versioned business catalog with stable names and owners", () => {
    const catalogPath = join(process.cwd(), "python", "lxeskill_cli", "lxeskill", "catalog.json");
    const entries = loadScriptToolCatalog(catalogPath);
    expect(entries.find((entry) => entry.name === "amazon_logistic_quote")).toMatchObject({
      module: "services.agent_cli.amazon_logistic.run",
      ownerSkills: ["fba-logistics-select"],
      timeoutMs: 300_000,
      artifactPaths: [{ field: "files[]", role: "deliverable" }],
    });
    expect(entries.find((entry) => entry.name === "logistics_rate_import")).toMatchObject({
      module: "services.agent_cli.amazon_logistic.logistics_update_ingest",
      ownerSkills: ["fba-logistics-rate-import"],
      timeoutMs: 600_000,
    });
    expect(entries.some((entry) => entry.name === "browser_auth_refresh")).toBe(false);
    expect(loadLxeSkillCommandCatalog(catalogPath).find((entry) => entry.name === "browser_auth_refresh")).toEqual({
      command: "lxeskill auth refresh",
      name: "browser_auth_refresh",
      visibility: "maintenance",
      ownerSkills: ["ziniao-browser"],
    });
    expect(loadLxeSkillCommandCatalog(catalogPath).find((entry) => entry.name === "ziniao_page"))
      .toMatchObject({
        ownerSkills: ["ziniao-browser"],
        artifactPaths: [{ field: "screenshot_path", role: "model_input" }],
      });
  });
});
