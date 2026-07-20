import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let activeRunRequest;
let steered = [];
let cancelCount = 0;
let loggingStatus = {
  local_file_enabled: true,
  file_path: "/tmp/runtime.log",
  disabled_reason: "",
  last_error: "",
  console_level: "info",
  file_level: "info",
};

for await (const line of input) {
  const request = JSON.parse(line);
  if (request.command === "initialize") {
    const lxeskillAvailable = process.env.FAKE_LXESKILL_UNAVAILABLE !== "1";
    write({ version: 7, type: "system.ready", payload: { state: "ready", logging: loggingStatus } });
    write({
      version: 7,
      id: request.id,
      ok: true,
      result: {
        ready: true,
        lxeskill_available: lxeskillAvailable,
        lxeskill_message: lxeskillAvailable ? "" : "No module named lxeskill",
        logging: loggingStatus,
      },
    });
    if (process.env.FAKE_LOGGING_FAILURE_EVENT === "1") {
      loggingStatus = {
        ...loggingStatus,
        local_file_enabled: false,
        disabled_reason: "sink_failed",
        last_error: "disk unavailable",
      };
      setTimeout(() => write({
        version: 7,
        type: "system.status",
        payload: {
          state: "ready",
          logging: loggingStatus,
        },
      }), 10);
    }
    if (process.env.FAKE_SESSION_CHANGE_EVENT === "1") {
      setTimeout(() => write({
        version: 7,
        type: "session.changed",
        thread_id: "session-1",
        payload: { changes: ["messages"] },
      }), 10);
    }
    continue;
  }
  if (request.command === "run_turn") {
    const resultMode = process.env.FAKE_RUN_TURN_RESULT;
    if (resultMode) {
      const result = {
        status: "completed",
        reply: "done",
        input_tokens: 1,
        output_tokens: 2,
        tool_calls: 0,
        remaining_steering: [],
      };
      if (resultMode === "missing_steering") delete result.remaining_steering;
      if (resultMode === "malformed_steering") result.remaining_steering = [{ text: "follow up", message_id: 42 }];
      if (resultMode === "negative_counter") result.input_tokens = -1;
      write({ version: 7, id: request.id, ok: true, result });
      continue;
    }
    activeRunRequest = request;
    continue;
  }
  if (request.command === "dashboard_call") {
    const crashMarker = process.env.FAKE_AGENT_CRASH_MARKER;
    if (request.payload.operation === "models.list" && crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, "crashed", "utf8");
      process.exit(23);
    }
    write({
      version: 7,
      id: request.id,
      ok: true,
      result: { items: [], total: 0 },
    });
    continue;
  }
  if (request.command === "cancel_turn") {
    cancelCount += 1;
    const active = activeRunRequest;
    activeRunRequest = undefined;
    write({ version: 7, id: request.id, ok: true, result: { cancelled: Boolean(active) } });
    if (active) {
      setTimeout(() => write({
        version: 7,
        id: active.id,
        ok: true,
        result: {
          status: "cancelled",
          reply: "",
          input_tokens: 0,
          output_tokens: 0,
          tool_calls: cancelCount,
          remaining_steering: steered,
        },
      }), 25);
    }
    continue;
  }
  if (request.command === "steer_turn") {
    if (activeRunRequest) {
      steered.push({
        text: request.payload.text,
        response_route_id: request.payload.response_route_id,
        message_id: request.payload.message_id,
      });
    }
    write({ version: 7, id: request.id, ok: true, result: { accepted: Boolean(activeRunRequest) } });
    continue;
  }
  if (request.command === "shutdown") {
    write({ version: 7, type: "system.status", payload: { state: "stopped" } });
    process.stdout.write(`${JSON.stringify({
      version: 7,
      id: request.id,
      ok: true,
      result: { stopped: true },
    })}\n`, () => process.exit(0));
    continue;
  }
  write({ version: 7, id: request.id, ok: true, result: {} });
}
