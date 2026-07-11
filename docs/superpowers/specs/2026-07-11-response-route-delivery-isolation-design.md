# Response Route Persistence and Delivery Isolation

## Problem

The TypeScript migration preserved `response_route_id` on `AgentJob`, but normal
inbound routing does not persist the corresponding `response_routes` row. The
Runtime therefore reaches the LLM successfully and fails on its first outbound
stream frame. Because stream delivery errors are chained through the provider,
one missing route produces repeated rejected promises and the final error reply
fails for the same reason.

## Reference Behavior

The `main` branch is the compatibility reference for observable behavior:

- create or refresh the response route before creating/rebinding the session;
- enqueue a turn only after that persistence succeeds;
- treat stream, typing, and final delivery as best-effort side effects;
- preserve the turn outcome and persisted assistant response when delivery fails.

The implementation remains a single Bun process and does not restore Python
runtime modules or worker boundaries.

## Design

1. `SessionRouter` explicitly calls `upsertResponseRoute()` for every permitted
   non-control inbound message after resolving the session and before steering or
   enqueue. Session persistence no longer carries an unused nested
   `response_route` value.
2. Runtime stream delivery records the first delivery failure, stops attempting
   later stream frames for that turn, and allows the provider response to finish.
3. Tool-file and final delivery failures are logged but do not create duplicate
   tool results or reject `runTurn()`. A failed final delivery still returns an
   error/completed `TurnOutcome` according to the agent work itself.
4. Typing remains best-effort during shutdown, matching existing behavior.

## Tests

- Router + real `SqliteRuntimeStore`: a normal inbound message persists its route
  before scheduler enqueue.
- Runtime: multiple deltas after the first emitter failure cause only one delivery
  attempt and still persist/return the assistant response.
- Runtime: failure to send an error/final response does not reject the turn.
- Existing routing, emitter, provider, storage, migration, and workspace suites
  remain green.
