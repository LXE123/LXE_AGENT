# Logging And Runtime Traces

Status: `Current`

The shared logging implementation is `packages/foundation/core/src/logging.ts`. Provider wire-trace sanitization and file layout are implemented by `packages/agent/runtime/src/providers/wire-trace.ts`.

## Logging Surfaces

The project separates three outputs with different audiences:

| Surface | Purpose | Typical level |
| --- | --- | --- |
| Terminal | concise operator-visible lifecycle and failures | `INFO` |
| Runtime log file | detailed structured diagnostics | `DEBUG` or configured level |
| Provider wire trace | opt-in provider protocol investigation | verbose, sanitized |

Reducing terminal noise must not remove useful runtime diagnostics. Conversely, enabling detailed files must not print secrets or large payloads to the terminal.

## Runtime Projection

Users select the `off`, `standard`, or `diagnostic` logging profile and retention period in Desktop settings. Desktop stores that choice in `var/config/settings.json` and projects the internal `LOG_LEVEL`, `RUNTIME_LOG_LEVEL`, `LOCAL_LOGS_ENABLED`, retention, and trace variables into child processes. Those environment names are process transport, not user-owned configuration files.

Terminal logs always use the human-readable pretty format; managed files use JSONL. Local files are written below the active `LXE_DATA_ROOT/logs/` tree with product-owned file names. Trace writers use dated session/turn directories so one failing call can be inspected without scanning an entire process log.

Wire traces use the main-compatible per-attempt layout:

```text
var/logs/sse_wire_traces/YYYYMMDD/HHMM_<session>/<turn>/step_<zero-based-step>_attempt_<attempt>.jsonl
```

Each successful attempt records `request_start`, `response_start`, every SDK `wire_event`, and one `request_end`. A failure before an HTTP response omits `response_start`. Existing legacy `provider.jsonl` files are retained, but new turns do not create them.

`LOCAL_LOGS_ENABLED` governs local file writes only. Ordinary console logging remains available when local logs are disabled. New Desktop installations use the `standard` profile, which enables `INFO` files with seven-day retention. Both Desktop processes emit `logging_configured` with the effective level, disabled reason, and resolved path during startup.

File responsibilities are intentionally separate:

- Electron Main and Gateway records (JSONL): `var/logs/runtime/YYYYMMDD/desktop.log`.
- Private `agent-cli` and Runtime records (JSONL): `var/logs/runtime/YYYYMMDD/runtime.log`.
- Python text logs (standalone `lxeskill` commands): `var/logs/runtime/YYYYMMDD/runtime-py.log`.
- Browser-auth text logs: `var/logs/browser_auth_service/YYYYMMDD/browser_auth_service.log`.
- Feishu raw events: `var/logs/feishu_raw_events/YYYYMMDD.jsonl`.
- Provider wire traces: `var/logs/sse_wire_traces/`.
- Ziniao diagnostic traces: `var/logs/ziniao_traces/`.

Runtime execution semantics are intentionally not duplicated into a second per-turn trace. Use `runtime.log` for correlated Turn, Provider-attempt, tool, cancellation, error, and usage summaries; durable usage remains in `turn_usage` SQLite. The retired `var/logs/agent_traces/` directory is no longer written and is removed naturally by the configured retention policy after its dated entries expire.

`LXE_DATA_ROOT` is the canonical `var` root. Desktop resolves every path above from it and exposes
`LXE_DATA_ROOT/logs` as the diagnostics directory. Desktop does not read, migrate, or delete the former
AppData/Application Support state tree.

## Record Shape And Context

The sink emits structured JSONL records to managed files. Records include timestamp, level, logger name, message, and scoped fields. Async context carries identifiers such as session, turn, job, or tool so nested modules do not have to repeat plumbing in every log call.

Use module-scoped logger names and stable event messages. Put high-cardinality IDs and details in fields rather than interpolating them into the message text.

## Level Guidance

- `INFO`: process lifecycle, accepted user work, concise turn/tool summaries, recoverable operator actions.
- `WARN`: degraded but continuing behavior, optional integration failures, retry exhaustion with fallback.
- `ERROR`: required operation failed or process health is compromised.
- `DEBUG`: request IDs, routes, tool arguments summaries, timing internals, provider and adapter diagnostics.

`gateway.event_loop` samples timer lateness every 500ms and emits an `event_loop_lag` warning when a sample fires 500ms late or more. Sustained records mean synchronous work is starving the event loop — WebSocket pings, card streaming, and heartbeats stall together — so treat them as a performance signal, not noise.

Successful health polling and repetitive stream updates should not dominate INFO output. Raw inbound content, credentials, cookies, headers, and complete tool payloads do not belong at any unsanitized level. Explicitly enabled wire traces are the only surface allowed to retain sanitized Provider request and stream content.

## Dashboard Lifecycle Events

| Event | Level | Meaning |
| --- | --- | --- |
| `dashboard_listening` | `INFO` | Dashboard bound successfully; `url` and `port` are the actual listener values. |
| `dashboard_port_fallback` | `WARN` | The requested fixed port failed and a dynamic port was selected. |
| `dashboard_available` | `INFO` | Gateway, Runtime, channels, and Dashboard are ready for use. |
| `dashboard_browser_opened` | `INFO` | The URL was handed to the operating system's default browser. |
| `dashboard_browser_open_failed` | `WARN` | Browser launch failed or timed out; Gateway remains ready. |
| `dashboard_browser_skipped` | `DEBUG` | Dashboard or automatic browser opening is disabled, or opening was already attempted. |

`gateway_ready` includes `dashboard_url` when the Dashboard is enabled. Browser-opening failures are optional integration failures and must never change Gateway health.

## Sanitization

Runtime tracing recursively redacts secret-like keys including authorization, API keys, tokens, passwords, cookies, signatures, and secret fields. Wire traces preserve readable `thinking_delta` content for protocol diagnosis, but replace:

- signatures and encrypted `redacted_thinking.data`;
- base64 and embedded media payloads;
- absolute local paths;
- strings beyond the trace size limit.

Sanitization is defense in depth, not permission to log arbitrary inputs. Call sites should still prefer summaries such as byte count, item count, status, and elapsed time.

## Retention And Shutdown

Retention cleanup deletes only managed dated log directories older than the configured period. It must not traverse unrelated user paths. File sinks are flushed during orderly shutdown and fatal-error handling so the final diagnostic record is not lost.

Business CLI commands reserve stdout for their JSON protocol. Their diagnostics go through logging/stderr; writing log prose to stdout would corrupt agent parsing.

## Troubleshooting

1. Confirm whether the missing information belongs in terminal logs, runtime files, or traces.
2. Check `LOCAL_LOGS_ENABLED` and the relevant level thresholds.
3. In Desktop settings, check both the Desktop/Gateway and `agent-cli` sink status, effective path, and safe failure detail.
4. Check `LOG_LEVELS` for a prefix override.
5. For provider streams, enable only the required trace surface and reproduce one turn.
6. Verify the resulting record is sanitized before sharing it.
7. Disable verbose tracing after the investigation.
