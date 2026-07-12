# Logging And Runtime Traces

Status: `Current`

The shared logging implementation is `packages/core/src/logging.ts`. Runtime trace sanitization and trace-file layout are implemented by `packages/runtime/src/trace.ts`.

## Logging Surfaces

The project separates three outputs with different audiences:

| Surface | Purpose | Typical level |
| --- | --- | --- |
| Terminal | concise operator-visible lifecycle and failures | `INFO` |
| Runtime log file | detailed structured diagnostics | `DEBUG` or configured level |
| Stream/wire trace | opt-in provider event investigation | verbose, sanitized |

Reducing terminal noise must not remove useful runtime diagnostics. Conversely, enabling detailed files must not print secrets or large payloads to the terminal.

## Configuration

- `LOG_LEVEL` controls the terminal threshold.
- `LOG_CONSOLE_FORMAT` selects the Bun terminal rendering: `pretty` (default, aligned human-readable lines with compact context) or `json` (raw JSONL, for machine consumers of stdout). Managed files always receive JSONL regardless of this setting.
- `RUNTIME_LOG_LEVEL` controls the managed runtime-file threshold.
- `LOG_LEVELS` applies longest-prefix logger overrides for noisy or important modules.
- `LOCAL_LOGS_ENABLED=1` enables local file writers.
- `LOG_FILE` selects the managed runtime-log base name.
- `LOCAL_LOG_RETENTION_DAYS` controls cleanup of dated local log directories.
- `AGENT_STREAM_TRACE_ENABLED` enables normalized stream traces.
- `AGENT_SSE_WIRE_TRACE_ENABLED` enables lower-level provider wire traces.

Local files are written below `logs/runtime/YYYYMMDD/` using the configured base name. Trace writers use dated session/turn directories so one failing call can be inspected without scanning an entire process log.

Wire traces use the main-compatible per-attempt layout:

```text
logs/sse_wire_traces/YYYYMMDD/HHMM_<session>/<turn>/step_<zero-based-step>_attempt_<attempt>.jsonl
```

Each successful attempt records `request_start`, `response_start`, every SDK `wire_event`, and one `request_end`. A failure before an HTTP response omits `response_start`. Existing legacy `provider.jsonl` files are retained, but new turns do not create them.

`LOCAL_LOGS_ENABLED` governs local file writes only. Ordinary console logging remains available when local logs are disabled.
The shipped runtime configuration leaves local file logging disabled. For development, copy the relevant values from
`.env.local.example` into `.env.local`; effective logging state and the resolved runtime path are emitted during startup.

File responsibilities are intentionally separate:

- Bun structured runtime records (JSONL): `logs/runtime/YYYYMMDD/runtime.log`.
- Python text logs (bridge tools and standalone scripts): `logs/runtime/YYYYMMDD/runtime-py.log`. Python derives the name from `LOG_FILE` by appending `-py` to the stem, so the two formats never share a file.
- Feishu raw events: `logs/feishu_raw_events/YYYYMMDD.jsonl`.
- Provider traces: `logs/agent_traces/` and `logs/sse_wire_traces/`.

## Record Shape And Context

The sink emits structured JSONL records to managed files. Records include timestamp, level, logger name, message, and scoped fields. Async context carries identifiers such as session, turn, job, or tool so nested modules do not have to repeat plumbing in every log call.

Use module-scoped logger names and stable event messages. Put high-cardinality IDs and details in fields rather than interpolating them into the message text.

## Level Guidance

- `INFO`: process lifecycle, accepted user work, concise turn/tool summaries, recoverable operator actions.
- `WARN`: degraded but continuing behavior, optional integration failures, retry exhaustion with fallback.
- `ERROR`: required operation failed or process health is compromised.
- `DEBUG`: request IDs, routes, tool arguments summaries, timing internals, provider and adapter diagnostics.

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
2. Check `LOCAL_LOGS_ENABLED`, `LOG_FILE`, and the relevant level thresholds.
3. Check `LOG_LEVELS` for a prefix override.
4. For provider streams, enable only the required trace surface and reproduce one turn.
5. Verify the resulting record is sanitized before sharing it.
6. Disable verbose tracing after the investigation.
