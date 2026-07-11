# Response Route Delivery Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every permitted inbound response route before turn dispatch and prevent outbound delivery failures from failing or flooding the agent turn.

**Architecture:** `SessionRouter` owns the ordering contract and writes the route before steering/enqueue, matching `main`. `TypeScriptAgentRuntime` treats typing, streaming, and final delivery as best-effort side effects while preserving tool-result closure semantics.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, `bun:test`, `bun:sqlite`.

## Global Constraints

- Keep the production topology as one Bun process.
- Do not restore Python Gateway, Runtime, worker, or compatibility imports.
- Preserve existing SQLite schema and route payload fields.
- Write every regression test before its production change and observe the expected failure.

---

### Task 1: Persist normal inbound routes before dispatch

**Files:**
- Modify: `apps/gateway/src/router.ts`
- Test: `apps/gateway/src/router.test.ts`

**Interfaces:**
- Consumes: `StoragePort.upsertResponseRoute(request: JsonObject): Promise<void>` and `responseRoutePayload(context)`.
- Produces: the invariant that `response_routes` is durable before `RouterSchedulerPort.enqueue()` or accepted steering.

- [x] **Step 1: Write the failing Router ordering test**

Add a storage operation log and assert a normal message performs `ensure/rebind`, then `route`, then `enqueue`. Assert the route payload contains `response_route_id`, `message_id`, `conversation_id`, and source identity.

- [x] **Step 2: Run the test and observe the missing route failure**

Run: `bun test apps/gateway/src/router.test.ts`

Expected: FAIL because `storage.routes` is empty for a normal message.

- [x] **Step 3: Implement the minimal ordering fix**

After `loadOrCreateSession(context)` and before `trySteer()`/`enqueue()`, execute:

```ts
await this.options.storage.upsertResponseRoute(responseRoutePayload(context));
```

Remove the unused nested `response_route` property from `ensureSession()` and `rebindSession()` requests.

- [x] **Step 4: Verify Router tests pass**

Run: `bun test apps/gateway/src/router.test.ts packages/runtime/test/storage.test.ts`

Expected: PASS.

### Task 2: Isolate stream and final delivery failures

**Files:**
- Modify: `packages/runtime/src/runtime.ts`
- Test: `packages/runtime/test/runtime.test.ts`

**Interfaces:**
- Consumes: `RuntimeEmitter.emit()` and `RuntimeEmitter.typing()`.
- Produces: `runTurn()` outcomes and canonical messages that depend only on agent execution, not outbound transport success.

- [x] **Step 1: Write failing stream-flood and final-failure tests**

Use a provider that invokes `onDelta` three times and returns `done`. Use an emitter that rejects stream/final calls. Assert only one stream attempt occurs, the assistant message is persisted, the completed outcome is returned, and `runTurn()` does not reject. Add a provider failure case whose error reply emitter also rejects and assert an `error` outcome is returned.

- [x] **Step 2: Run the tests and observe delivery exceptions escaping**

Run: `bun test packages/runtime/test/runtime.test.ts`

Expected: FAIL because stream delivery rejects the provider chain and the error/final emit rejects `runTurn()`.

- [x] **Step 3: Implement best-effort delivery**

Track a per-step `streamDeliveryFailed` flag. Catch the first stream emitter exception, log one warning, set the flag, and skip later frames. Wrap typing start and final/error emitter calls in best-effort helpers that log and return without changing the turn outcome. Keep tool-file failures inside the existing tool result error boundary.

- [x] **Step 4: Verify Runtime tests pass**

Run: `bun test packages/runtime/test/runtime.test.ts packages/runtime/test/provider.test.ts apps/gateway/src/emitter.test.ts`

Expected: PASS with no unhandled rejection output.

### Task 3: Verify the repaired production chain

**Files:**
- Modify only if verification exposes a contract mismatch.

**Interfaces:**
- Consumes: the Router persistence and Runtime isolation invariants from Tasks 1 and 2.
- Produces: a migration-safe, verified branch ready for another live Feishu message.

- [x] **Step 1: Run migration and workspace gates**

Run:

```powershell
& "$env:USERPROFILE\.bun\bin\bun.exe" run verify:migration
& "$env:USERPROFILE\.bun\bin\bun.exe" run verify
```

Expected: all tests, typechecks, and production builds pass.

- [x] **Step 2: Run a real SQLite route probe**

On a temporary copy of `user_session_db`, route a representative Feishu event and verify `getResponseRoute(job.response_route_id)` succeeds before executing the captured job.

- [x] **Step 3: Check repository boundaries and worktree**

Run:

```powershell
git diff --check
& "$env:USERPROFILE\.bun\bin\bun.exe" run check:ts-boundary
git status --short
```

Expected: no whitespace errors, boundary check passes, and only this repair's intended files are modified.
