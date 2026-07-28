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

The `serve` protocol is private to the Electron application. It is not installed
on the system `PATH` and is versioned independently. The current contract uses
`version: 8`; any other version is rejected instead of running a mixed
Desktop/agent-cli pair. The separately versioned, one-shot `agent-cli exec`
interface is documented in [Agent CLI exec](../harness/runtime/agent_cli_exec.md).

## Request and response envelopes

```json
{"version":8,"id":"request-1","command":"has_pending_events","payload":{"session_id":"session-1"}}
{"version":8,"id":"request-1","ok":true,"result":{"pending":false}}
```

Errors preserve the request ID:

```json
{"version":8,"id":"request-1","ok":false,"error":{"code":"RunUnavailable","message":"run not found"}}
```

Supported commands are `initialize`, `run_turn`, `cancel_turn`, `steer_turn`,
`ensure_session`, `append_pending_event`, `has_pending_events`,
`dashboard_call`, and `shutdown`. `dashboard_call` carries a validated `{ operation, input }`
envelope and returns the operation result directly; it has no HTTP method, path,
status, `Request`, or `Response`. `initialize` supplies resource, data, and workspace roots before
any stateful command is accepted.

Every successful `run_turn` result includes `remaining_steering`, even when it
is an empty array. The Gateway validates the complete result and rejects a
missing array, malformed message, or invalid usage counter as an
`AgentProtocolError`; it never substitutes an empty handoff.

Every `run_turn` AgentJob also carries a required `diagnostics` array. Each item
is a bounded, strictly validated observation with provider, operation, stage,
error name and redacted actual error. A known cause requires a
`verified_reason`; a fixed replacement additionally requires a tested
`mapping_id`. Diagnostics belong to the current turn's volatile system prompt,
not `user_input` or transcript history.

## Events and session continuity

Turn execution emits `thread.started`, `turn.started`, `item.completed`,
`turn.completed`, and `turn.failed` events. Typing and scheduled wake events use
`typing.changed` and `agent.wake`. A successful transcript message commit emits
`session.changed` with `changes:["messages"]`; a successful turn-usage commit emits
the same event with `changes:["usage"]`. The event contains no transcript body.
Desktop session invalidation is driven only by these persistence events and is
coalesced into fixed two-second windows; outbound `item.completed` stream frames
never invalidate Dashboard data. The stable `thread_id` is the LXE session ID;
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
