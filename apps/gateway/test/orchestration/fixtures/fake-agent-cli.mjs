import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let activeRunRequest;
let cancelCount = 0;

for await (const line of input) {
  const request = JSON.parse(line);
  if (request.command === "initialize") {
    write({ version: 1, type: "system.ready", payload: { state: "ready" } });
    write({ version: 1, id: request.id, ok: true, result: { ready: true } });
    continue;
  }
  if (request.command === "health") {
    write({ version: 1, id: request.id, ok: true, result: { ready: true, fake: true, cancel_count: cancelCount } });
    continue;
  }
  if (request.command === "run_turn") {
    activeRunRequest = request;
    continue;
  }
  if (request.command === "dashboard_request") {
    const crashMarker = process.env.FAKE_AGENT_CRASH_MARKER;
    if (request.payload.path === "/api/crash" && crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, "crashed", "utf8");
      process.exit(23);
    }
    write({
      version: 1,
      id: request.id,
      ok: true,
      result: { status: 200, body: { path: request.payload.path } },
    });
    continue;
  }
  if (request.command === "cancel_turn") {
    cancelCount += 1;
    const active = activeRunRequest;
    activeRunRequest = undefined;
    write({ version: 1, id: request.id, ok: true, result: { cancelled: Boolean(active) } });
    if (active) {
      setTimeout(() => write({
        version: 1,
        id: active.id,
        ok: true,
        result: {
          status: "cancelled",
          reply: "",
          input_tokens: 0,
          output_tokens: 0,
          tool_calls: 0,
        },
      }), 25);
    }
    continue;
  }
  if (request.command === "steer_turn") {
    write({ version: 1, id: request.id, ok: true, result: { accepted: Boolean(activeRunRequest) } });
    continue;
  }
  if (request.command === "shutdown") {
    write({ version: 1, type: "system.status", payload: { state: "stopped" } });
    process.stdout.write(`${JSON.stringify({
      version: 1,
      id: request.id,
      ok: true,
      result: { stopped: true },
    })}\n`, () => process.exit(0));
    continue;
  }
  write({ version: 1, id: request.id, ok: true, result: {} });
}
