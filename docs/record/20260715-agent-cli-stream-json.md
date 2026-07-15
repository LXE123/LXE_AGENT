# Private agent-cli stream protocol

Electron Main launches the private `agent-cli` process in non-interactive mode:

```text
agent-cli serve --input-format stream-json --output-format stream-json
```

The transport follows the useful process boundaries of Codex `exec --json` and
Claude Code's stream JSON mode:

- stdin accepts one JSON request envelope per line;
- stdout contains protocol JSON lines only;
- diagnostics and runtime logs go to stderr;
- every request has an `id`, so responses can complete out of order;
- lifecycle and turn progress are independent event envelopes.

The protocol is private to the Electron application. It is not installed on the
system `PATH` and is versioned independently with `version: 1`.

## Request and response envelopes

```json
{"version":1,"id":"request-1","command":"health","payload":{}}
{"version":1,"id":"request-1","ok":true,"result":{"ready":true}}
```

Errors preserve the request ID:

```json
{"version":1,"id":"request-1","ok":false,"error":{"code":"RunUnavailable","message":"run not found"}}
```

Supported commands are `initialize`, `run_turn`, `cancel_turn`, `steer_turn`,
the session and pending-event storage operations, `dashboard_request`, `health`,
and `shutdown`. `initialize` supplies resource, data, and workspace roots before
any stateful command is accepted.

## Events and session continuity

Turn execution emits `thread.started`, `turn.started`, `item.completed`,
`turn.completed`, and `turn.failed` events. Typing and scheduled wake events use
`typing.changed` and `agent.wake`. The stable `thread_id` is the LXE session ID;
reusing it resumes the existing session state after the process or desktop app
restarts.

Cancellation and steering use the active `run_id`. Main can therefore keep
reading new stdin commands while a long turn is running. On an unexpected crash,
the Gateway rejects outstanding requests, pauses its scheduler, and restarts the
private process with bounded backoff.

## Shutdown

`shutdown` first cancels active tool processes and stops the agent runtime, then
writes `system.status` and the correlated success response. Only after stdout has
flushed does the process exit. Electron's tray Exit action stops channels,
Gateway state, `agent-cli`, and its registered tool subprocesses in that order.
