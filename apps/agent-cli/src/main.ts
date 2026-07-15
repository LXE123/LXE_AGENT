import { createInterface } from "node:readline";
import type { AgentEvent, AgentResponse } from "@lxe/desktop-protocol";
import { AgentProtocolServer } from "./server";

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

void (async () => {
  for await (const line of input) {
    if (line.trim()) void server.accept(line);
  }
  await server.shutdown();
  process.exit(0);
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    input.close();
    void server.shutdown().finally(() => process.exit(0));
  });
}
