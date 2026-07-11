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
- `RUNTIME_LOG_LEVEL` controls the managed runtime-file threshold.
- `LOG_LEVELS` applies longest-prefix logger overrides for noisy or important modules.
- `LOCAL_LOGS_ENABLED=1` enables local file writers.
- `LOG_FILE` selects the managed runtime-log base name.
- `LOCAL_LOG_RETENTION_DAYS` controls cleanup of dated local log directories.
- `AGENT_STREAM_TRACE_ENABLED` enables normalized stream traces.
- `AGENT_SSE_WIRE_TRACE_ENABLED` enables lower-level provider wire traces.

Local files are written below `logs/runtime/YYYYMMDD/` using the configured base name. Trace writers use dated session/turn directories so one failing call can be inspected without scanning an entire process log.

`LOCAL_LOGS_ENABLED` governs local file writes only. Ordinary console logging remains available when local logs are disabled.

## Record Shape And Context

The sink emits structured JSONL records to managed files. Records include timestamp, level, logger name, message, and scoped fields. Async context carries identifiers such as session, turn, job, or tool so nested modules do not have to repeat plumbing in every log call.

Use module-scoped logger names and stable event messages. Put high-cardinality IDs and details in fields rather than interpolating them into the message text.

## Level Guidance

- `INFO`: process lifecycle, accepted user work, concise turn/tool summaries, recoverable operator actions.
- `WARN`: degraded but continuing behavior, optional integration failures, retry exhaustion with fallback.
- `ERROR`: required operation failed or process health is compromised.
- `DEBUG`: request IDs, routes, tool arguments summaries, timing internals, provider and adapter diagnostics.

Successful health polling and repetitive stream updates should not dominate INFO output. Raw inbound content, credentials, cookies, headers, and complete tool payloads do not belong at any unsanitized level.

## Sanitization

Runtime tracing recursively redacts secret-like keys including authorization, API keys, tokens, passwords, cookies, signatures, and secret fields. It also replaces:

- encrypted or redacted thinking blocks;
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
