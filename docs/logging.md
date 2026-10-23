# 日志与诊断

本文统一维护日志位置、级别、关联字段、事件、脱敏和故障隔离规则。托管文件使用 JSONL，Desktop 配置后的终端输出使用 pretty 格式；日志只提供诊断证据，持久用量和会话状态以 SQLite 为准。

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

Users select the `off`, `standard`, or `diagnostic` logging profile and retention period in Desktop settings. Desktop stores that choice in `<data-root>/config/settings.json` and projects the internal `LOG_LEVEL`, `RUNTIME_LOG_LEVEL`, `LOCAL_LOGS_ENABLED`, retention, and trace variables into child processes. Those environment names are process transport, not user-owned configuration files.

Terminal logs always use the human-readable pretty format; managed files use JSONL. Local files are written below the active `LXE_DATA_ROOT/logs/` tree with product-owned file names. Trace writers use dated session/turn directories so one failing call can be inspected without scanning an entire process log.

Wire traces use the main-compatible per-attempt layout:

```text
<data-root>/logs/sse_wire_traces/YYYYMMDD/HHMM_<session>/<turn>/step_<zero-based-step>_attempt_<attempt>.jsonl
```

Each successful attempt records `request_start`, `response_start`, every SDK `wire_event`, and one `request_end`. A failure before an HTTP response omits `response_start`. Existing legacy `provider.jsonl` files are retained, but new turns do not create them.

`LOCAL_LOGS_ENABLED` governs local file writes only. Ordinary console logging remains available when local logs are disabled. New Desktop installations use the `standard` profile, which enables `INFO` files with seven-day retention. Both Desktop processes emit `logging_configured` with the effective level, disabled reason, and resolved path during startup.

File responsibilities are intentionally separate:

- Electron Main and Gateway records (JSONL): `<data-root>/logs/runtime/YYYYMMDD/desktop.log`.
- Private `agent-cli` and Runtime records (JSONL): `<data-root>/logs/runtime/YYYYMMDD/runtime.log`.
- Python text logs (standalone `lxeskill` commands): `<data-root>/logs/runtime/YYYYMMDD/runtime-py.log`.
- Browser-auth text logs: `<data-root>/logs/browser_auth_service/YYYYMMDD/browser_auth_service.log`.
- Feishu raw events: `<data-root>/logs/feishu_raw_events/YYYYMMDD.jsonl`.
- Provider wire traces: `<data-root>/logs/sse_wire_traces/`.
- Ziniao diagnostic traces: `<data-root>/logs/ziniao_traces/`.

Runtime execution semantics are intentionally not duplicated into a second per-turn trace. Use `runtime.log` for correlated Turn, Provider-attempt, tool, cancellation, error, and usage summaries; durable usage remains in `turn_usage` SQLite. The retired `<data-root>/logs/agent_traces/` directory is no longer written and is removed naturally by the configured retention policy after its dated entries expire.

`<data-root>` is the active application data directory supplied through `LXE_DATA_ROOT`.
Desktop exposes its `logs/` subdirectory as the diagnostics directory. Default locations, overrides
and upgrade migration are maintained in [Program and user data](desktop/data-location.md).

## Record Shape And Context

The sink emits structured JSONL records to managed files. Records include timestamp, level, logger name, message, and scoped fields. Async context carries identifiers such as session, turn, job, or tool so nested modules do not have to repeat plumbing in every log call.

Use module-scoped logger names and stable event messages. Put high-cardinality IDs and details in fields rather than interpolating them into the message text.

Core `AsyncLocalStorage` propagates these fields across asynchronous calls:

- `session_id`
- `turn_id`
- `response_route_id`
- `message_id`
- `task_id`

Active context overrides child-logger and call-site fields so a nested operation cannot accidentally change its parent correlation IDs. A background completion callback must explicitly restore its saved context because it may run after the originating turn has ended.

Typical accepted-message chain:

```text
feishu_inbound_normalized(message_id, response_route_id)
  -> inbound_received(session_id)
  -> message_queued(turn_id)
  -> scheduler_job_dispatched
  -> turn_started
  -> provider_attempt_started/completed
  -> tool_started/completed
  -> turn_completed
  -> scheduler_job_released
```

Each Runtime turn has exactly one `turn_started` and exactly one terminal `turn_completed`. The terminal status is `completed`, `cancelled`, or `error`.

## Level Guidance

- `INFO`: process lifecycle, accepted user work, concise turn/tool summaries, recoverable operator actions.
- `WARN`: degraded but continuing behavior, optional integration failures, retry exhaustion with fallback.
- `ERROR`: required operation failed or process health is compromised; emit the terminal failure once from the module responsible for the final outcome.
- `DEBUG`: request IDs, routes, timing internals, provider and adapter decisions; use counts and status instead of tool payloads.

`gateway.event_loop` samples timer lateness every 500ms and emits an `event_loop_lag` warning when a sample fires 500ms late or more. Sustained records mean synchronous work is starving the event loop — WebSocket pings, card streaming, and heartbeats stall together — so treat them as a performance signal, not noise.

Successful health polling and repetitive stream updates should not dominate INFO output. Raw inbound content, credentials, cookies, headers, and complete tool payloads do not belong at any unsanitized level. Explicitly enabled wire traces are the only surface allowed to retain sanitized Provider request and stream content.

## 排障入口

按会话、turn、job 或 tool 标识串联日志，再定位负责该阶段的实现。下表提供常用入口；具体事件名和 reason 字段以对应日志调用为准，不在手册中复制完整枚举。

| 阶段 | 查看内容与实现入口 |
| --- | --- |
| 回合与模型调用 | `turn_started` / `turn_completed`、Provider attempt 和工具执行；[Runtime](../packages/agent/runtime/src/engine/runtime.ts) |
| 入站路由与调度 | session、route、排队、steering 和取消；[Router](../apps/gateway/src/orchestration/router.ts)、[Scheduler](../apps/gateway/src/orchestration/scheduler.ts) |
| Heartbeat | 唤醒、合并、延后或丢弃的原因；[Heartbeat bridge](../apps/gateway/src/orchestration/heartbeat-bridge.ts) |
| 飞书接入与交付 | 连接、消息归一化、资源获取和卡片交付；[飞书适配](../apps/gateway/src/channels/feishu/) |
| exec 进程 | 创建、等待、退出、终止和后台完成通知；[Process manager](../packages/agent/runtime/src/tooling/coding/process-manager.ts) |
| 用量同步 | `data_sync_uploaded`、`data_sync_skipped`、`data_sync_failed`；[TurnUsageSyncService](../packages/agent/runtime/src/operations/turn-usage-sync.ts) |
| MCP 与 Skill | 连接及工具注册、Skill 发现与刷新；[MCP](../packages/agent/runtime/src/tooling/mcp.ts)、[Skill](../packages/agent/runtime/src/tooling/skills.ts) |
| 启动与关闭 | 组件 ready、停止和失败回滚；[生命周期手册](desktop/gateway/gateway_lifecycle.md) |

用量同步属于 agentcli；马帮登录态维护由 lxeskillCLI 按需处理，排障入口见 [CLI 云端通信](lxeskill-cli/cloud-access.md)。

Desktop Renderer 通过 preload IPC 与 Main 通信，不启动 Dashboard HTTP listener。启动与可用性排障查看 Gateway lifecycle、agent-cli 握手及桌面健康状态；不使用旧的 `dashboard_listening` 或浏览器自动打开事件。

## Sanitization

Runtime tracing recursively redacts secret-like keys including authorization, API keys, tokens, passwords, cookies, signatures, and secret fields. Wire traces preserve readable `thinking_delta` content for protocol diagnosis, but replace:

- signatures and encrypted `redacted_thinking.data`;
- base64 and embedded media payloads;
- absolute local paths;
- strings beyond the trace size limit.

Sanitization is defense in depth, not permission to log arbitrary inputs. Normal logs must not include full user text, Provider bodies, tool inputs/outputs, command text, process output, credentials, HTTP headers, cookies, or Axios objects. Call sites should prefer byte count, item count, status, and elapsed time. Explicitly enabled wire traces are the single exception for sanitized Provider request and stream content.

Core serialization handles sensitive keys, binary values, cycles and `BigInt`; only safe Error fields and a bounded cause chain survive. Depth, item and string budgets are defined in [`logging.ts`](/packages/foundation/core/src/logging.ts), with explicit truncation markers.

The official Feishu SDK logger is suppressed to avoid duplicate Axios diagnostics. The adapter records connection lifecycle, CardKit records operation/state decisions, and Runtime owns the final outbound-delivery warning. Lookup/download failures retain endpoint, HTTP status, provider code, subcode and log ID when available. They distinguish observations from verified causes and never translate an unmapped status or SDK message into an invented permissions, expiration, network or client-version diagnosis.

## Failure Isolation, Retention And Shutdown

Logger writers, traces, retention cleanup and local-file sinks must never change a business result. A local sink disables itself after its first write failure, reports `logging_sink_failed` once, and exposes `disabledReason="sink_failed"` plus a safe `lastError` in logging status.

Retention cleanup deletes only managed dated log directories older than the configured period. It must not traverse unrelated user paths. File sinks are flushed during orderly shutdown and fatal-error handling so the final diagnostic record is not lost.

`agent-cli serve` and business CLI commands reserve stdout for their JSON protocol. Their diagnostics go through logging/stderr; writing log prose to stdout would corrupt agent parsing.

## Troubleshooting

1. Confirm whether the missing information belongs in terminal logs, runtime files, or traces.
2. Check `LOCAL_LOGS_ENABLED` and the relevant level thresholds.
3. In Desktop settings, check both the Desktop/Gateway and `agent-cli` sink status, effective path, and safe failure detail.
4. Check `LOG_LEVELS` for a prefix override.
5. For provider streams, enable only the required trace surface and reproduce one turn.
6. Verify the resulting record is sanitized before sharing it.
7. Disable verbose tracing after the investigation.
