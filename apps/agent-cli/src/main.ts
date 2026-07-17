import { createInterface } from "node:readline";
import { createLogger } from "@lxe/core";
import type { AgentEvent, AgentResponse } from "@lxe/desktop-protocol";
import { AgentProtocolServer } from "./server";

const logger = createLogger("agent.cli.main");

const arguments_ = process.argv.slice(2);
const mode = arguments_.find((value) => !value.startsWith("-")) ?? "serve";
const optionValue = (name: string): string => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? String(arguments_[index + 1] ?? "") : "";
};
if (mode !== "serve") {
  process.stderr.write(`agent-cli: unsupported mode: ${mode}\n`);
  process.exit(2);
}
for (const [name, value] of [
  ["--input-format", optionValue("--input-format")],
  ["--output-format", optionValue("--output-format")],
] as const) {
  if (value && value !== "stream-json") {
    process.stderr.write(`agent-cli: ${name} only supports stream-json\n`);
    process.exit(2);
  }
}

// stdout is reserved for NDJSON. Runtime logging falls back to console.log when
// no sink is configured, so route it to stderr before constructing the service.
console.log = (...values: unknown[]): void => {
  process.stderr.write(`${values.map(String).join(" ")}\n`);
};

let writes = Promise.resolve();
const write = (message: AgentResponse | AgentEvent): Promise<void> => {
  const line = `${JSON.stringify(message)}\n`;
  writes = writes.then(() => new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(line, (error) => error ? rejectWrite(error) : resolveWrite());
  }));
  return writes;
};

const server = new AgentProtocolServer({
  write,
  exit: (code) => {
    void writes.finally(() => process.exit(code));
  },
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping: Promise<void> | undefined;
const stop = (code: number): Promise<void> => {
  if (stopping) return stopping;
  input.close();
  stopping = server.shutdown().catch((error) => {
    logger.error("agent_cli_shutdown_failed", { error });
  }).then(() => writes).catch((error) => {
    logger.error("agent_cli_protocol_flush_failed", { error });
  }).finally(() => {
    process.exit(code);
  });
  return stopping;
};

void (async () => {
  for await (const line of input) {
    if (line.trim()) void server.accept(line);
  }
  await stop(0);
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop(0);
  });
}

process.on("unhandledRejection", (cause) => {
  logger.error("unhandled_rejection", {
    error: cause instanceof Error ? cause : new Error(String(cause)),
  });
  void stop(1);
});
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { error });
  void stop(1);
});
