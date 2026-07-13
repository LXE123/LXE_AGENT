# Local Agent Storage

Status: `Current`

The Bun runtime owns local agent state through `packages/runtime/src/storage.ts` and `bun:sqlite`. The default database is `local_agent.sqlite3`; conversation transcripts are stored separately as append-only JSONL.

## Ownership Boundary

Local storage contains operational state required to resume and route agent work:

- agent sessions and their current metadata;
- channel response-route bindings;
- pending events produced while a session is stopped or busy;
- usage/accounting records needed by the local runtime;
- transcript checkpoints and replacement markers.

The local database is not the source of truth for remote product data, provider credentials, or business workbooks. PostgreSQL remains limited to explicitly configured pricing/data-server responsibilities rather than replacing local runtime state.

## SQLite And Transcript Split

SQLite stores indexed mutable state that needs transactional reads and updates. JSONL stores chronological canonical messages efficiently without rewriting the entire transcript after each tool step.

This split supports two access paths:

- full session loading replays the transcript and reconstructs model-visible state;
- Dashboard display reads immutable transcript events, inserts lifecycle markers, and pages contiguous assistant/tool chains without applying model-context replacements;
- lightweight session-record loading reads metadata without transcript replay for hot paths such as routing, wake checks, emitter checks, and persistence guards.

Code must choose the light path only when message content is not required.

## Transcript Records

Transcript files are append-only under normal operation. Records represent canonical user, assistant, and tool messages. A context replacement checkpoint can supersede an older prefix after summary compaction without mutating historical lines in place.

Replay applies records in order and honors replacement checkpoints. A stat-based cache may reuse a replay result while file identity, size, and modification metadata remain unchanged; append or replacement invalidates that view.

## Consistency Rules

- Route binding and session identity updates are transactional.
- Appending a message must not require rewriting the full session snapshot.
- Canonical tool calls and tool results remain paired across persistence and replay.
- Pending events survive cancellation/stop boundaries until a later user turn consumes them.
- Lightweight record reads never claim to include transcript state.
- Context replacement is explicit and replayable; it is not silent deletion.

## Paths And Local Safety

The database, transcripts, local environment overrides, logs, downloaded artifacts, and connector state are machine-local runtime data. They must remain ignored by Git and must not be modified through model-facing coding tools.

Do not place secrets in SQLite merely because the file is ignored. Provider and platform credentials stay in private environment/config surfaces designed for that purpose.

## Backup And Recovery

Before manual migration or destructive repair:

1. stop the gateway so no writer remains active;
2. copy the SQLite database and transcript directory together;
3. record the current commit and schema/runtime version;
4. validate the copy before changing the originals.

Deleting only SQLite or only transcript files can leave route/session metadata inconsistent with conversation history. Prefer tested migration or rebuild commands over hand-editing database rows and JSONL.

## Diagnostics

When session state appears stale, inspect in this order:

1. route binding and session metadata in SQLite;
2. pending-event state and scheduler ownership;
3. transcript tail and the most recent replacement checkpoint;
4. replay cache invalidation signals;
5. runtime logs for append, replacement, or transaction failures.

Tests covering storage should use temporary paths and isolated databases. They must not read the developer machine's ignored runtime state.
