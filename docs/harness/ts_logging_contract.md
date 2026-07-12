# Bun/TS structured logging contract

The Bun Gateway and Runtime write one JSON object per console or local-file line. Logs are diagnostic evidence; SQLite remains the source for durable usage statistics and session state.

## Levels

| Level | Contract |
|---|---|
| `INFO` | User-visible lifecycle boundaries and successful outcomes |
| `DEBUG` | Queueing, deduplication, retries, stream progress, and internal decisions |
| `WARN` | Recoverable degradation, rejected or damaged input, and bounded timeout |
| `ERROR` | Terminal failure, emitted once by the module responsible for the final outcome |

Production console output starts at `INFO`. Development file logs may include `DEBUG`. `LOCAL_LOGS_ENABLED=0` disables only the local file sink, not console logging.

## Correlation context

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

## Event families

| Boundary | Stable events |
|---|---|
| Runtime turn | `turn_started`, `provider_attempt_started`, `provider_stream_heartbeat`, `provider_attempt_completed`, `provider_attempt_failed`, `tool_started`, `tool_completed`, `heartbeat_noop`, `pending_events_popped`, `pending_events_attached`, `turn_completed` |
| Routing | `inbound_received`, `permission_denied`, `session_created`, `session_rebound`, `message_queued`, `message_steered`, `control_completed` |
| Scheduler | `scheduler_job_enqueued`, `scheduler_job_dispatched`, `scheduler_job_released`, `scheduler_stop_requested`, `scheduler_pending_cleared`, `scheduler_steering_requeued` |
| Heartbeat | `heartbeat_requested`, `heartbeat_deduplicated`, `heartbeat_deferred`, `heartbeat_dropped`, `heartbeat_enqueued` |
| Feishu ingress | `feishu_inbound_rejected`, `feishu_inbound_normalized`, `feishu_inbound_sink_completed`, `feishu_inbound_failed` |
| Feishu connection | `feishu_connection_starting`, `feishu_connected`, `feishu_reconnecting`, `feishu_reconnected`, `feishu_connection_failed`, `feishu_connection_stopped` |
| Idle restart | `feishu_restart_scheduled`, `feishu_restart_deferred`, `feishu_restart_started`, `feishu_restart_completed`, `feishu_restart_failed`, `feishu_restart_stop_timed_out` |
| Background process | `process_started`, `process_yielded_to_background`, `process_completed`, `process_timeout`, `process_killed`, `process_force_killed`, `process_notification_enqueued`, `process_wake_requested`, `process_wake_unavailable` |
| Maintenance | `maintenance_configured`, `maintenance_task_started`, `maintenance_task_completed`, `maintenance_single_flight_coalesced`, `maintenance_single_flight_rerun`, `auth_refresh_succeeded`, `auth_refresh_failed`, `data_sync_uploaded`, `data_sync_skipped`, `data_sync_failed` |
| MCP and skills | `mcp_enabled`, `mcp_connected`, `mcp_startup_failed`, `mcp_disabled`, `mcp_disconnected`, `skill_catalog_loaded`, `skill_external_skipped` |
| Gateway lifecycle | `gateway_starting`, `gateway_ready`, `gateway_start_failed`, `gateway_stopping`, `gateway_stopped`, `startup_component_ready`, `shutdown_component_stopping`, `shutdown_component_stopped`, `shutdown_component_failed` |

Heartbeat drop/defer reasons are restricted to `autonomy_suspended`, `no_pending_events`, `session_busy`, `session_missing`, and `invalid_source`. Feishu normalize rejection reasons are restricted to `duplicate`, `stale`, `group_bot_identity_missing`, `group_without_bot_mention`, `missing_sender_open_id`, and `empty_content`.

## Privacy and failure isolation

Logs must not include full user text, Provider request bodies, tool arguments or outputs, command text, process output, credentials, HTTP headers, cookies, or Axios request/response objects.

Core serialization:

- redacts exact sensitive keys such as `authorization`, `cookie`, `token`, `secret`, `password`, and `signature`;
- truncates strings at 8,000 characters, nesting at depth 8, and collections at 100 entries;
- represents binary values by type and byte count;
- handles cycles and `BigInt` safely;
- emits only safe Error fields and a bounded cause chain.

Logger writers, trace writers, retention cleanup, and local-file sinks must never change a business result. A local sink is disabled after its first write failure, reports `logging_sink_failed` once, and exposes `disabledReason="sink_failed"` plus a safe `lastError` through logging status.

The official Feishu SDK is restricted to fatal logging and receives the project's safe adapter. CardKit records operation/state decisions; the Runtime remains the only owner of the final outbound-delivery warning.
