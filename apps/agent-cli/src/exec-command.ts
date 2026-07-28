import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentJob, WorkspaceContext } from "@lxe/protocol";
import { resolveWorkspaceContext, sameWorkspaceContext } from "@lxe/core";
import {
  createAgentRuntimeHost,
  type AgentRuntimeHost,
  type AgentRuntimeHostOptions,
} from "./runtime-host";
import { AgentRunHandle } from "./run-handle";
import { ExecReporter, type TextWriter } from "./exec-protocol";
import {
  acquireExecSessionLock,
  assertExecSessionId,
  execSessionPaths,
  inspectExecSession,
  latestExecSession,
  newExecSessionId,
  type ExecSessionLock,
  type ExecSessionPaths,
} from "./exec-session";
import {
  execRuntimeEnvironment,
  resolveExecRuntimePaths,
  type ExecRuntimePaths,
} from "./exec-paths";

type Environment = Record<string, string | undefined>;

export class ExecUsageError extends Error {
  readonly code = "ExecUsageError";
}

class ExecTurnFailedError extends Error {
  readonly code = "ExecTurnFailed";
}

class ExecCancelledError extends Error {
  readonly code = "ExecCancelled";
}

export interface ParsedExecArguments {
  action: "run" | "resume";
  prompt?: string;
  cwd?: string;
  outputLastMessage?: string;
  json: boolean;
  ephemeral: boolean;
  last: boolean;
  sessionId?: string;
  help: boolean;
}

export interface ExecSignalSource {
  subscribe(signal: "SIGINT" | "SIGTERM", listener: () => void): () => void;
}

export interface RunExecCommandDependencies {
  environment?: Environment;
  cwd?: string;
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  stdout?: TextWriter;
  stderr?: TextWriter;
  resolvePaths?: (environment: Environment) => ExecRuntimePaths;
  createHost?: (options: AgentRuntimeHostOptions) => AgentRuntimeHost;
  createId?: () => string;
  signalSource?: ExecSignalSource;
}

export const EXEC_HELP = `Run LXE Agent non-interactively

Usage:
  agent-cli exec [OPTIONS] [PROMPT|-]
  agent-cli exec resume [SESSION_ID | --last] [OPTIONS] [PROMPT|-]

Options:
  -C, --cd <DIR>                    Set the agent working directory
      --json                        Write versioned JSONL events to stdout
      --ephemeral                   Do not persist the exec session
  -o, --output-last-message <FILE>  Write the final agent message to a file
      --last                        Resume the latest session in the current worktree
  -h, --help                        Print help
`;

const valueAfter = (args: readonly string[], index: number, option: string): string => {
  const value = args[index + 1];
  if (value === undefined || !value.trim()) throw new ExecUsageError(`${option} requires a value`);
  return value;
};

const jsonOutputRequested = (args: readonly string[]): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--") return false;
    if (value === "-C" || value === "--cd" || value === "-o" || value === "--output-last-message") {
      index += 1;
      continue;
    }
    if (value === "--json") return true;
  }
  return false;
};

export function parseExecArguments(args: readonly string[]): ParsedExecArguments {
  const values = [...args];
  const action = values[0] === "resume" ? "resume" : "run";
  let index = action === "resume" ? 1 : 0;
  let cwd: string | undefined;
  let outputLastMessage: string | undefined;
  let json = false;
  let ephemeral = false;
  let last = false;
  let help = false;
  let optionsEnded = false;
  const positionals: string[] = [];
  while (index < values.length) {
    const value = values[index]!;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && (value === "-C" || value === "--cd")) {
      cwd = valueAfter(values, index, value);
      index += 2;
      continue;
    }
    if (!optionsEnded && (value === "-o" || value === "--output-last-message")) {
      outputLastMessage = valueAfter(values, index, value);
      index += 2;
      continue;
    }
    if (!optionsEnded && value === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && value === "--ephemeral") {
      ephemeral = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && value === "--last") {
      last = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && (value === "-h" || value === "--help")) {
      help = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      throw new ExecUsageError(`unsupported exec option: ${value}`);
    }
    positionals.push(value);
    index += 1;
  }

  if (help) return { action, json, ephemeral, last, help, ...(cwd ? { cwd } : {}), ...(outputLastMessage ? { outputLastMessage } : {}) };
  if (action === "run") {
    if (positionals.length > 1) throw new ExecUsageError("exec accepts at most one prompt argument");
    if (last) throw new ExecUsageError("--last is only supported by exec resume");
    return {
      action,
      json,
      ephemeral,
      last: false,
      help: false,
      ...(cwd ? { cwd } : {}),
      ...(outputLastMessage ? { outputLastMessage } : {}),
      ...(positionals[0] !== undefined ? { prompt: positionals[0] } : {}),
    };
  }

  if (ephemeral) throw new ExecUsageError("--ephemeral cannot be used with exec resume");
  if (last) {
    if (positionals.length > 1) throw new ExecUsageError("exec resume --last accepts at most one prompt argument");
    return {
      action,
      json,
      ephemeral: false,
      last: true,
      help: false,
      ...(cwd ? { cwd } : {}),
      ...(outputLastMessage ? { outputLastMessage } : {}),
      ...(positionals[0] !== undefined ? { prompt: positionals[0] } : {}),
    };
  }
  if (positionals.length < 1) throw new ExecUsageError("exec resume requires a session id or --last");
  if (positionals.length > 2) throw new ExecUsageError("exec resume accepts one session id and one prompt");
  let sessionId: string;
  try {
    sessionId = assertExecSessionId(positionals[0]!);
  } catch (error) {
    throw new ExecUsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    action,
    json,
    ephemeral: false,
    last: false,
    help: false,
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(outputLastMessage ? { outputLastMessage } : {}),
    ...(positionals[1] !== undefined ? { prompt: positionals[1] } : {}),
  };
}

const defaultWriter = (stream: NodeJS.WriteStream): TextWriter => (text) =>
  new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(text, (error) => error ? rejectWrite(error) : resolveWrite());
  });

const readProcessStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const processSignals: ExecSignalSource = {
  subscribe: (signal, listener) => {
    process.on(signal, listener);
    return () => process.off(signal, listener);
  },
};

export async function resolveExecPrompt(
  promptArgument: string | undefined,
  stdinIsTTY: boolean,
  readStdin: () => Promise<string>,
): Promise<string> {
  const explicitStdin = promptArgument === "-";
  const shouldRead = explicitStdin || !stdinIsTTY;
  const stdin = shouldRead ? (await readStdin()).trim() : "";
  if (explicitStdin || promptArgument === undefined) {
    if (!stdin) throw new ExecUsageError("exec requires a prompt argument or non-empty stdin");
    return stdin;
  }
  const prompt = promptArgument.trim();
  if (!prompt) throw new ExecUsageError("exec prompt must not be empty");
  return stdin ? `${prompt}\n\n<stdin>\n${stdin}\n</stdin>` : prompt;
}

const atomicWrite = (pathInput: string, cwd: string, content: string): void => {
  const path = isAbsolute(pathInput) ? resolve(pathInput) : resolve(cwd, pathInput);
  if (!existsSync(dirname(path))) throw new Error(`output directory does not exist: ${dirname(path)}`);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the write failure. */ }
    throw error;
  }
};

const usageFrom = (outcome: {
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
}) => ({
  input_tokens: outcome.input_tokens,
  output_tokens: outcome.output_tokens,
  tool_calls: outcome.tool_calls,
});

const cliSource = (sessionId: string) => ({
  platform: "cli",
  chat_id: sessionId,
  chat_type: "local",
  user_id: "cli-local",
  user_name: "CLI",
});

const jobFor = (
  createId: () => string,
  sessionId: string,
  workspace: WorkspaceContext,
  prompt: string,
): AgentJob => {
  const turnId = createId();
  return {
    job_id: turnId,
    session_id: sessionId,
    session_key: `agent:main:cli:session:${sessionId}`,
    response_route_id: `cli:${turnId}`,
    user_id: "cli-local",
    conversation_id: sessionId,
    is_group: false,
    message_id: createId(),
    user_input: prompt,
    job_kind: "turn",
    sender_nick: "CLI",
    workspace,
    source: cliSource(sessionId),
    raw_data: { origin: "cli" },
    user_content_blocks: [],
    diagnostics: [],
  };
};

const createTemporarySessionPaths = (): ExecSessionPaths => {
  const root = mkdtempSync(join(tmpdir(), "lxe-agent-cli-exec-"));
  return { root, database: join(root, "agent.sqlite3"), lock: join(root, "session.lock") };
};

interface PreparedSession {
  sessionId: string;
  workspace: WorkspaceContext;
  paths: ExecSessionPaths;
  lock: ExecSessionLock;
  ephemeral: boolean;
  created: boolean;
}

const prepareSession = async (
  parsed: ParsedExecArguments,
  paths: ExecRuntimePaths,
  invocationCwd: string,
): Promise<PreparedSession> => {
  if (parsed.action === "run") {
    const sessionId = newExecSessionId();
    const workspace = resolveWorkspaceContext(parsed.cwd ?? invocationCwd);
    const sessionPaths = parsed.ephemeral
      ? createTemporarySessionPaths()
      : execSessionPaths(paths.dataRoot, sessionId);
    let lock: ExecSessionLock;
    try {
      lock = acquireExecSessionLock(sessionPaths);
    } catch (error) {
      if (parsed.ephemeral) rmSync(sessionPaths.root, { recursive: true, force: true });
      throw error;
    }
    return {
      sessionId,
      workspace,
      paths: sessionPaths,
      lock,
      ephemeral: parsed.ephemeral,
      created: true,
    };
  }

  const requestedWorkspace = resolveWorkspaceContext(parsed.cwd ?? invocationCwd);
  if (parsed.last) {
    const latest = await latestExecSession(paths.dataRoot, requestedWorkspace);
    if (!latest) throw new Error(`no exec session found for worktree: ${requestedWorkspace.worktree}`);
    const lock = acquireExecSessionLock(latest.paths);
    try {
      const current = await inspectExecSession(latest.paths, latest.record.session_id);
      if (!current) throw new Error(`exec session not found: ${latest.record.session_id}`);
      return {
        sessionId: current.record.session_id,
        workspace: current.record.workspace,
        paths: latest.paths,
        lock,
        ephemeral: false,
        created: false,
      };
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  const sessionId = parsed.sessionId!;
  const sessionPaths = execSessionPaths(paths.dataRoot, sessionId);
  const lock = acquireExecSessionLock(sessionPaths);
  try {
    const snapshot = await inspectExecSession(sessionPaths, sessionId);
    if (!snapshot) throw new Error(`exec session not found: ${sessionId}`);
    if (parsed.cwd && !sameWorkspaceContext(requestedWorkspace, snapshot.record.workspace)) {
      throw new Error(`exec session workspace does not match --cd: ${sessionId}`);
    }
    return {
      sessionId,
      workspace: snapshot.record.workspace,
      paths: sessionPaths,
      lock,
      ephemeral: false,
      created: false,
    };
  } catch (error) {
    lock.release();
    throw error;
  }
};

export async function runExecCommand(
  args: readonly string[],
  dependencies: RunExecCommandDependencies = {},
): Promise<number> {
  const jsonRequested = jsonOutputRequested(args);
  const stdout = dependencies.stdout ?? defaultWriter(process.stdout);
  const stderr = dependencies.stderr ?? defaultWriter(process.stderr);
  const reporter = new ExecReporter(jsonRequested, stdout, stderr);
  const invocationCwd = resolve(dependencies.cwd ?? process.cwd());
  const environment = { ...(dependencies.environment ?? process.env) };
  let session: PreparedSession | undefined;
  let host: AgentRuntimeHost | undefined;
  let signalExit = false;
  let aborting: Promise<void> | undefined;
  let exitCode = 1;
  const handle = new AgentRunHandle();
  const unsubscribers: Array<() => void> = [];
  try {
    const parsed = parseExecArguments(args);
    if (parsed.help) {
      await stdout(EXEC_HELP);
      exitCode = 0;
    } else {
      const prompt = await resolveExecPrompt(
        parsed.prompt,
        dependencies.stdinIsTTY ?? process.stdin.isTTY === true,
        dependencies.readStdin ?? readProcessStdin,
      );
      const runtimePaths = (dependencies.resolvePaths ?? ((env) => resolveExecRuntimePaths({ environment: env })))(environment);
      session = await prepareSession(parsed, runtimePaths, invocationCwd);
      mkdirSync(join(runtimePaths.dataRoot, "tmp"), { recursive: true });
      const runtimeEnvironment = execRuntimeEnvironment(runtimePaths, session.paths.database, environment);
      const createHost = dependencies.createHost ?? createAgentRuntimeHost;
      const reporterForHost = reporter;
      host = createHost({
        agentSoulPath: runtimePaths.agentSoulPath,
        skillsRoot: runtimePaths.skillsRoot,
        userSkillsRoot: runtimePaths.userSkillsRoot,
        lxeskillCatalogPath: runtimePaths.lxeskillCatalogPath,
        llmConfigRoot: runtimePaths.llmConfigRoot,
        permissionPolicyPath: runtimePaths.permissionPolicyPath,
        dataRoot: runtimePaths.dataRoot,
        legacyWorkspace: session.workspace,
        environment: runtimeEnvironment,
        emitter: {
          emit: (request) => reporterForHost.emit(request),
          typing: async () => undefined,
        },
        allowedSkillTypes: new Set(["*"]),
      });
      const signalSource = dependencies.signalSource ?? processSignals;
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        unsubscribers.push(signalSource.subscribe(signal, () => {
          signalExit = true;
          aborting ??= handle.abort(true);
        }));
      }
      await host.start();
      const source = cliSource(session.sessionId);
      await host.ensureSession({
        session_id: session.sessionId,
        source,
        workspace: session.workspace,
        ...(session.created ? { entry_text: prompt } : {}),
      });
      const createId = dependencies.createId ?? (() => randomUUID().replaceAll("-", ""));
      const job = jobFor(createId, session.sessionId, session.workspace, prompt);
      await reporter.threadStarted(session.sessionId);
      await reporter.turnStarted(session.sessionId, job.job_id);
      const outcome = await host.runTurn(job, handle);
      const usage = usageFrom(outcome);
      if (signalExit || outcome.status === "cancelled") {
        if (aborting) await aborting;
        await reporter.turnFailed(session.sessionId, job.job_id, new ExecCancelledError("agent turn cancelled"), usage);
        exitCode = signalExit ? 130 : 1;
      } else if (outcome.status === "error") {
        await reporter.turnFailed(session.sessionId, job.job_id, new ExecTurnFailedError(outcome.reply), usage);
        exitCode = 1;
      } else {
        await reporter.ensureFinalItem(session.sessionId, job.job_id, outcome.reply);
        if (parsed.outputLastMessage) atomicWrite(parsed.outputLastMessage, invocationCwd, outcome.reply);
        await reporter.turnCompleted(session.sessionId, job.job_id, usage);
        await reporter.finalMessage(outcome.reply);
        exitCode = 0;
      }
    }
  } catch (error) {
    await reporter.error(error);
    exitCode = error instanceof ExecUsageError ? 2 : signalExit ? 130 : 1;
  } finally {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    if (aborting) await aborting;
    if (host) {
      try {
        await host.stop();
      } catch (error) {
        await reporter.error(error);
        if (!signalExit) exitCode = 1;
      }
    }
    if (session) {
      try {
        session.lock.release();
      } catch (error) {
        await reporter.error(error);
        if (!signalExit) exitCode = 1;
      }
      if (session.ephemeral) {
        try {
          rmSync(session.paths.root, { recursive: true, force: true });
        } catch (error) {
          await reporter.error(error);
          if (!signalExit) exitCode = 1;
        }
      }
    }
    await reporter.flush();
  }
  return exitCode;
}
