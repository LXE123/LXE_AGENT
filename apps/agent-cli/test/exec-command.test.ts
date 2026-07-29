import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentJob, EmitRequest } from "@lxe/protocol";
import { SqliteRuntimeStore, type TurnOutcome } from "@lxe/runtime";
import {
  ExecUsageError,
  parseExecArguments,
  resolveExecPrompt,
  runExecCommand,
  type ExecSignalSource,
  type RunExecCommandDependencies,
} from "../src/exec-command";
import {
  acquireExecSessionLock,
  execSessionPaths,
  newExecSessionId,
  ExecSessionLockedError,
} from "../src/exec-session";
import type { ExecRuntimePaths } from "../src/exec-paths";
import type { AgentRuntimeHost, AgentRuntimeHostOptions } from "../src/runtime-host";

const workspaceRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-agent-cli-exec-test-"));
  mkdirSync(join(root, ".git"));
  return root;
};

const pathsFor = (root: string): ExecRuntimePaths => ({
  sourceRoot: root,
  resourceRoot: root,
  projectRoot: root,
  dataRoot: join(root, "var"),
  agentSoulPath: join(root, "SOUL.md"),
  skillsRoot: join(root, "skills"),
  userSkillsRoot: join(root, "user-skills"),
  lxeskillCatalogPath: join(root, "catalog.json"),
  llmConfigRoot: join(root, "config", "llm"),
  permissionPolicyPath: join(root, "config", "permission_policy.yaml"),
  managedPythonPath: join(root, ".venv", "bin", "python"),
  managedPath: "",
  playwrightBrowsersPath: "",
});

const streamRequest = (job: AgentJob, state: "delta" | "final", seq: number): EmitRequest => ({
  emit_id: `emit-${seq}`,
  session_id: job.session_id,
  turn_id: job.job_id,
  response_route_id: job.response_route_id,
  content: state === "final" ? "done" : "do",
  thinking: "",
  redacted_thinking_count: 0,
  thinking_elapsed_ms: 0,
  tool_pending: false,
  tool_elapsed_ms: 5,
  tool_steps: [{
    id: "tool-1",
    name: "read",
    title: "Read",
    detail: "README.md",
    icon_token: "file_outlined",
    status: state === "final" ? "success" : "running",
    duration_ms: state === "final" ? 5 : 0,
  }],
  process_parts: [],
  files: [],
  emit_kind: "stream",
  stream_type: "final_answer",
  state,
  seq,
  display_metrics: {
    status: state === "final" ? "completed" : "running",
    phase: state === "final" ? "generating_answer" : "running_tool",
    elapsed_ms: 5,
    model: "test",
    input_tokens: 3,
    output_tokens: 4,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    context_tokens: 3,
    context_window_tokens: 1_000,
  },
});

interface FakeHostOptions {
  prompts?: string[];
  outcome?: TurnOutcome;
  waitForAbort?: boolean;
  forcedKills?: number[];
  startError?: Error;
}

type CreateHost = NonNullable<RunExecCommandDependencies["createHost"]>;

const fakeHostFactory = (fake: FakeHostOptions = {}): CreateHost =>
  (options: AgentRuntimeHostOptions): AgentRuntimeHost => {
    const databasePath = String(options.environment.LXE_AGENT_SQLITE_DB_PATH ?? "");
    const store = new SqliteRuntimeStore(databasePath, { legacyWorkspace: options.legacyWorkspace });
    return {
      start: async () => {
        if (fake.startError) throw fake.startError;
        await store.start();
      },
      stop: () => store.stop(),
      ensureSession: (request) => store.ensureSession(request),
      appendPendingEvent: (sessionId, event) => store.appendPendingEvent(sessionId, event),
      hasPendingEvents: (sessionId) => store.hasPendingEvents(sessionId),
      resolveArtifact: async () => undefined,
      resolveAttachment: async () => undefined,
      dashboardCall: async () => ({}) as never,
      health: () => ({ ready: true }),
      runTurn: async (job, handle) => {
        fake.prompts?.push(job.user_input);
        if (fake.waitForAbort) {
          const unregister = handle.registerProcess({
            kill: () => undefined,
            forceKill: () => { fake.forcedKills?.push(1); },
          });
          if (!handle.signal.aborted) {
            await new Promise<void>((resolveAbort) =>
              handle.signal.addEventListener("abort", () => resolveAbort(), { once: true }));
          }
          unregister();
          return { status: "cancelled", reply: "", input_tokens: 0, output_tokens: 0, tool_calls: 0 };
        }
        const outcome = fake.outcome ?? {
          status: "completed",
          reply: "done",
          input_tokens: 3,
          output_tokens: 4,
          tool_calls: 1,
        };
        if (outcome.status === "completed") {
          await options.emitter.emit(streamRequest(job, "delta", 1));
          await options.emitter.emit(streamRequest(job, "final", 2));
        }
        return outcome;
      },
    };
  };

const captureDependencies = (
  root: string,
  options: Omit<RunExecCommandDependencies, "cwd" | "resolvePaths" | "stdout" | "stderr"> = {},
) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      cwd: root,
      environment: { LOCAL_LOGS_ENABLED: "0", LXE_SOURCE_ROOT: root },
      stdinIsTTY: true,
      readStdin: async () => "",
      stdout: (text: string) => { stdout.push(text); },
      stderr: (text: string) => { stderr.push(text); },
      resolvePaths: () => pathsFor(root),
      createHost: fakeHostFactory(),
      ...options,
    } satisfies RunExecCommandDependencies,
  };
};

describe("exec argument and input contract", () => {
  test("parses run and resume forms", () => {
    expect(parseExecArguments(["--json", "-C", "/repo", "hello"])).toMatchObject({
      action: "run", json: true, cwd: "/repo", prompt: "hello",
    });
    expect(parseExecArguments(["resume", "--last", "follow up"])).toMatchObject({
      action: "resume", last: true, prompt: "follow up",
    });
    expect(() => parseExecArguments(["resume", "--ephemeral", "--last", "hello"]))
      .toThrow("--ephemeral cannot be used");
    expect(() => parseExecArguments(["--unknown", "hello"])).toThrow(ExecUsageError);
    expect(() => parseExecArguments(["resume", "not-a-session", "hello"])).toThrow(ExecUsageError);
    expect(parseExecArguments(["--", "--json"])).toMatchObject({ json: false, prompt: "--json" });
  });

  test("supports prompt, stdin, and prompt plus stdin", async () => {
    expect(await resolveExecPrompt("hello", true, async () => "ignored")).toBe("hello");
    expect(await resolveExecPrompt("-", false, async () => "from stdin\n")).toBe("from stdin");
    expect(await resolveExecPrompt("summarize", false, async () => "context\n")).toBe(
      "summarize\n\n<stdin>\ncontext\n</stdin>",
    );
    await expect(resolveExecPrompt(undefined, true, async () => "")).rejects.toThrow("requires a prompt");
  });
});

describe("exec command", () => {
  test("keeps the final answer on stdout and progress on stderr", async () => {
    const root = workspaceRoot();
    const prompts: string[] = [];
    const capture = captureDependencies(root, {
      stdinIsTTY: false,
      readStdin: async () => "context",
      createHost: fakeHostFactory({ prompts }),
    });
    try {
      expect(await runExecCommand(["-o", "plain-answer.md", "summarize"], capture.dependencies)).toBe(0);
      expect(capture.stdout.join("")).toBe("done\n");
      expect(readFileSync(join(root, "plain-answer.md"), "utf8")).toBe("done");
      expect(capture.stderr.join("")).toContain("thread ");
      expect(capture.stderr.join("")).toContain("[tool] Read: running");
      expect(capture.stderr.join("")).not.toContain("done");
      expect(prompts).toEqual(["summarize\n\n<stdin>\ncontext\n</stdin>"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes only public versioned JSONL events in json mode", async () => {
    const root = workspaceRoot();
    const capture = captureDependencies(root);
    try {
      expect(await runExecCommand(["--json", "hello"], capture.dependencies)).toBe(0);
      expect(capture.stderr).toEqual([]);
      const events = capture.stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
      expect(events.map((event) => event.type)).toEqual([
        "thread.started",
        "turn.started",
        "item.updated",
        "item.updated",
        "item.completed",
        "item.completed",
        "turn.completed",
      ]);
      expect(events.every((event) => event.version === 1)).toBe(true);
      expect(events.some((event) => "ok" in event || "command" in event || "payload" in event)).toBe(false);
      expect(events.at(-1).usage).toEqual({ input_tokens: 3, output_tokens: 4, tool_calls: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists sessions, resumes by id and --last, and writes the final message file", async () => {
    const root = workspaceRoot();
    const first = captureDependencies(root);
    try {
      expect(await runExecCommand(["--json", "-o", "answer.md", "first"], first.dependencies)).toBe(0);
      expect(readFileSync(join(root, "answer.md"), "utf8")).toBe("done");
      const firstEvents = first.stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
      const sessionId = String(firstEvents[0].thread_id);

      const liveLock = acquireExecSessionLock(execSessionPaths(join(root, "var"), sessionId));
      try {
        const blocked = captureDependencies(root);
        expect(await runExecCommand(["resume", sessionId, "--json", "blocked"], blocked.dependencies)).toBe(1);
        expect(JSON.parse(blocked.stdout.at(-1)!).error.code).toBe("ExecSessionLocked");
      } finally {
        liveLock.release();
      }

      const exact = captureDependencies(root);
      expect(await runExecCommand(["resume", sessionId, "--json", "second"], exact.dependencies)).toBe(0);
      const exactEvents = exact.stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
      expect(exactEvents[0].thread_id).toBe(sessionId);

      const last = captureDependencies(root);
      expect(await runExecCommand(["resume", "--last", "--json", "third"], last.dependencies)).toBe(0);
      const lastEvents = last.stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
      expect(lastEvents[0].thread_id).toBe(sessionId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not persist ephemeral sessions", async () => {
    const root = workspaceRoot();
    const capture = captureDependencies(root);
    try {
      expect(await runExecCommand(["--ephemeral", "hello"], capture.dependencies)).toBe(0);
      const persistentRoot = join(root, "var", "db", "exec-sessions");
      expect(existsSync(persistentRoot) ? readdirSync(persistentRoot) : []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects workspace changes while resuming an exact session", async () => {
    const root = workspaceRoot();
    const other = workspaceRoot();
    const first = captureDependencies(root);
    try {
      expect(await runExecCommand(["--json", "first"], first.dependencies)).toBe(0);
      const sessionId = JSON.parse(first.stdout[0]!).thread_id as string;
      const resumed = captureDependencies(root);
      expect(await runExecCommand(["resume", sessionId, "--json", "-C", other, "second"], resumed.dependencies)).toBe(1);
      expect(resumed.stderr.join("")).toBe("");
      expect(JSON.parse(resumed.stdout.at(-1)!).error.message).toContain("does not match --cd");

      const wrongLast = captureDependencies(root);
      expect(await runExecCommand(["resume", "--last", "--json", "-C", other, "second"], wrongLast.dependencies))
        .toBe(1);
      expect(JSON.parse(wrongLast.stdout.at(-1)!).error.message).toContain("no exec session found for worktree");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("preserves sanitized initialization and turn failures with nonzero exit codes", async () => {
    const root = workspaceRoot();
    try {
      const startFailure = captureDependencies(root, {
        createHost: fakeHostFactory({ startError: new Error("provider token=secret-value failed") }),
      });
      expect(await runExecCommand(["--json", "hello"], startFailure.dependencies)).toBe(1);
      const startError = JSON.parse(startFailure.stdout.at(-1)!);
      expect(startError.type).toBe("error");
      expect(startError.error.message).toContain("token=[redacted]");
      expect(startError.error.message).not.toContain("secret-value");

      const turnFailure = captureDependencies(root, {
        createHost: fakeHostFactory({
          outcome: { status: "error", reply: "执行失败: provider offline", input_tokens: 1, output_tokens: 0, tool_calls: 0 },
        }),
      });
      expect(await runExecCommand(["--json", "-o", "failed-answer.md", "hello"], turnFailure.dependencies)).toBe(1);
      const failed = JSON.parse(turnFailure.stdout.at(-1)!);
      expect(failed).toMatchObject({ type: "turn.failed", error: { message: "执行失败: provider offline" } });
      expect(existsSync(join(root, "failed-answer.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns 2 for invalid usage", async () => {
    const root = workspaceRoot();
    const capture = captureDependencies(root);
    try {
      expect(await runExecCommand(["--json", "--unknown"], capture.dependencies)).toBe(2);
      expect(JSON.parse(capture.stdout.at(-1)!).error.code).toBe("ExecUsageError");
      expect(await runExecCommand(["resume", "--json", "not-a-session", "hello"], capture.dependencies)).toBe(2);
      expect(JSON.parse(capture.stdout.at(-1)!).error.message).toContain("invalid exec session id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels the active turn and returns 130 on signals", async () => {
    const root = workspaceRoot();
    const forcedKills: number[] = [];
    let sigint: (() => void) | undefined;
    const signals: ExecSignalSource = {
      subscribe: (signal, listener) => {
        if (signal === "SIGINT") sigint = listener;
        return () => {
          if (sigint === listener) sigint = undefined;
        };
      },
    };
    const capture = captureDependencies(root, {
      signalSource: signals,
      createHost: fakeHostFactory({ waitForAbort: true, forcedKills }),
    });
    try {
      const running = runExecCommand(["--json", "hello"], capture.dependencies);
      while (!sigint) await Bun.sleep(1);
      sigint();
      expect(await running).toBe(130);
      expect(JSON.parse(capture.stdout.at(-1)!).type).toBe("turn.failed");
      expect(forcedKills).toEqual([1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("exec session lock", () => {
  test("rejects two live owners for one session", () => {
    const root = workspaceRoot();
    const sessionId = newExecSessionId();
    const paths = execSessionPaths(join(root, "var"), sessionId);
    const lock = acquireExecSessionLock(paths);
    try {
      expect(() => acquireExecSessionLock(paths)).toThrow(ExecSessionLockedError);
    } finally {
      lock.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
