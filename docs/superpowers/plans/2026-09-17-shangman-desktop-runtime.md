# Shangman Desktop Runtime and Captcha Implementation Plan

> **For agentic workers:** This plan is executed inline in the already assigned `pool-2` worktree. Git staging, commit, push, and real ERP requests are explicitly out of scope for this phase.

**Goal:** Connect the existing Wisdom Indonesia goods-export client and unified Skill/CLI route to Desktop safe configuration, a non-persistent production gate, and a session-only manual captcha channel without exposing secrets or captcha values.

**Architecture:** Desktop persists tenant ID and username in settings and processed password plus the complete Basic Authorization value in Electron safeStorage. The Desktop runtime injects only the resolved `LXE_SHANGMAN_*` environment contract; the Python side reads no Desktop files. The agent-cli process owns an in-memory, loopback-only, one-time captcha broker and exposes a session-bound runtime tool plus dashboard RPC projection so the captcha image can be shown without entering the model transcript; the answer is consumed only by the next same-session CLI invocation.

**Tech Stack:** TypeScript/Bun agent runtime and Electron Desktop, React Dashboard, Python `lxeskill` CLI, `aiohttp`, Bun tests, and `uv` pytest.

**Spec:** User-provided phase-three delegation and `docs/handoff/CURRENT_HANDOFF.md`.

## Global Constraints

- Work only in `/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-2` on `codex/shangman-erp-export-client`.
- Keep `LXE_SHANGMAN_PROD_ENABLED=true` non-persistent and host-injected; no Agent, Skill, CLI, or settings form may enable it.
- Use `LXE_SHANGMAN_TENANT_ID`, `LXE_SHANGMAN_USERNAME`, `LXE_SHANGMAN_PROCESSED_PASSWORD`, and `LXE_SHANGMAN_BASIC_AUTH`; never reintroduce the old split password/Basic username/password contract.
- Never return or log processed password, Basic Authorization, captcha text, or captcha image base64; retain captcha state only in the current agent-cli process and current session.
- Do not add OCR, browser automation, WAF/captcha bypass, Windows Enrollment, real credentials, real ERP probes, or network tests against the real host.
- Use the existing artifact filename `智慧印尼-商品-YYYYMMDD-HHMMSS.xlsx` and preserve the one canonical goods-export route.
- Verify focused Python/Bun/Desktop tests, `git diff --check`, and `git status`; do not stage or commit.

---

### Task 1: Add the Shangman Desktop configuration contract

**Files:**
- Modify: `apps/gateway/src/bootstrap/env.ts`
- Modify: `apps/desktop/src/main/config-store/model.ts`
- Modify: `apps/desktop/src/main/config-store/public-types.ts`
- Modify: `apps/desktop/src/main/config-store/secrets.ts`
- Modify: `apps/desktop/src/main/config-store/validation.ts`
- Modify: `apps/desktop/src/main/config-store/setup.ts`
- Modify: `apps/desktop/src/main/config-store/store.ts`
- Modify: `packages/foundation/desktop-protocol/src/index.ts`
- Test: `apps/desktop/test/config-store.test.ts`, `apps/desktop/test/config-store-validation.test.ts`, `apps/gateway/test/bootstrap/env.test.ts`

**Interfaces:**
- Settings state: `integrations.shangman = { managed: boolean; tenant_id: string; username: string }`.
- Encrypted secrets: `shangman_processed_password` and `shangman_basic_auth`.
- Public setup state exposes `managed`, `configured`, `issues`, `tenant_id`, `username`, `password_configured`, and `basic_auth_configured`, never secret values.
- `DesktopSetupService.environment()` emits the four credential variables plus `LXE_SHANGMAN_PROD_ENABLED` only when the startup/source environment contains the exact enabled value; it emits `"false"`/`"0"` otherwise and never persists the flag.

- [ ] Add schema-version-compatible defaults and parsing for `shangman`, keeping schema 8 files readable and rejecting secret-looking settings fields.
- [ ] Validate the two non-sensitive fields and both encrypted secret fields; preserve blank-secret patch semantics and make `clear` remove both secrets.
- [ ] Add focused tests proving settings JSON has no secrets, state JSON has only booleans, environment has the new names, the old names are absent, and the gate is not persisted.

### Task 2: Replace the stage-one client and CLI runtime secret contract

**Files:**
- Modify: `python/lxeskill_cli/services/shangman/goods_export.py`
- Modify: `python/lxeskill_cli/services/agent_cli/shangman/_workflow.py`
- Modify: `python/lxeskill_cli/services/agent_cli/shangman/goods_export_run.py`
- Modify: `python/lxeskill_cli/tests/shangman/test_goods_export.py`
- Modify: `python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py`

**Interfaces:**
- `ShangmanCredentials(tenant_id, username, processed_password, basic_auth)` uses the complete Basic Authorization header value.
- Requests send `Authorization: <basic_auth>` directly; no `aiohttp.BasicAuth` object and no split Basic username/password variables.
- CLI reads only `LXE_SHANGMAN_TENANT_ID`, `LXE_SHANGMAN_USERNAME`, `LXE_SHANGMAN_PROCESSED_PASSWORD`, and `LXE_SHANGMAN_BASIC_AUTH` for credentials, plus the host-injected non-secret gate and captcha-channel variables.

- [ ] Write failing fake-client tests for the new env names, old-name rejection, complete Authorization header use, and secret redaction.
- [ ] Change the client/CLI to the new contract and preserve the canonical artifact payload and all supported natural-language routing.
- [ ] Add explicit recoverable errors for missing gate, credentials, captcha channel, expired challenge, and explicitly reported incorrect captcha without replacing observed business diagnostics.

### Task 3: Implement the in-memory session-bound captcha broker

**Files:**
- Create: `packages/agent/runtime/src/tooling/shangman-captcha.ts`
- Modify: `packages/agent/runtime/src/index.ts`
- Modify: `apps/agent-cli/src/runtime-host.ts`
- Modify: `apps/agent-cli/src/dashboard-service.ts`
- Modify: `packages/foundation/desktop-protocol/src/dashboard-rpc.ts`
- Modify: `packages/foundation/desktop-protocol/src/index.ts`
- Modify: `packages/agent/runtime/src/tooling/coding/public-types.ts`
- Modify: `packages/agent/runtime/src/tooling/coding/exec-tools.ts`
- Modify: `packages/agent/runtime/src/tooling/exec-shell.ts`
- Test: `packages/agent/runtime/test/tooling/shangman-captcha.test.ts`, `apps/agent-cli/test/dashboard-service.test.ts`

**Interfaces:**
- The broker creates an opaque challenge for `{ session_id, turn_id, image_data }`, expires it quickly, and stores the image plus a pending answer promise only in process memory.
- A native `shangman_captcha` tool accepts only `{ challenge_id }` and current runtime context; it waits for the session's dashboard answer and returns only `{ accepted: true }` or a canonical recoverable error.
- Dashboard RPC adds current-session-only `sessions.shangman_captcha` and `sessions.shangman_captcha.answer`; snapshots contain the image data URL and opaque ID but never an answer.
- Child command environments receive only a short-lived broker endpoint/token and opaque challenge metadata. A Python client call can publish an image, then consume exactly one answer for the same session/challenge; the answer is never part of command arguments or output.

- [ ] Test session mismatch, challenge mismatch, expiry, duplicate answer, wrong/empty answer handling, and cleanup on session stop/runtime stop.
- [ ] Add the minimum runtime plumbing so an `exec` child receives session/turn context and the broker channel without allowing arbitrary model-provided environment overrides.
- [ ] Ensure broker/image/answer fields are excluded from logs, stored transcripts, normal question snapshots, and final tool content.

### Task 4: Add the captcha card to the existing Dashboard session surface

**Files:**
- Modify: `apps/dashboard/src/desktop/settings-model.ts` only if shared types need no duplication
- Modify: `apps/dashboard/src/features/sessions/user-questions.tsx` or the session view that owns question cards
- Modify: `apps/dashboard/src/api/queries.ts` and related API types if required by the existing RPC hooks
- Modify: `apps/dashboard/src/shared/i18n.tsx`
- Modify: `apps/dashboard/src/styles.css`
- Test: `apps/dashboard/test/features/sessions/*` and/or a focused captcha-card test

**Interfaces:**
- The UI fetches the ephemeral challenge through the existing dashboard query/invalidation loop, renders the image from the broker-provided data URL, and submits `{ session_id, challenge_id, code }` through the new RPC.
- The code field is an uncontrolled/password input or local component state only; it is never put in `sessionStorage`, React query cache, normal conversation state, or a message payload.

- [ ] Render waiting, submitting, expired, rejected, and accepted states with explicit Chinese/English copy.
- [ ] Refresh/remove the card when the challenge is consumed, the session stops, or the agent restarts.
- [ ] Test that an answer is sent only to the current session/challenge and that the image/code do not appear in ordinary session transcript fixtures.

### Task 5: Wire the Desktop settings page and handoff

**Files:**
- Modify: `apps/dashboard/src/desktop/settings-model.ts`
- Modify: `apps/dashboard/src/desktop/shell.tsx`
- Modify: `apps/dashboard/src/shared/i18n.tsx`
- Modify: `apps/desktop/src/main/ipc-validation.ts`
- Modify: `apps/desktop/test/ipc-validation.test.ts`
- Modify: `apps/dashboard/test/desktop/settings-model.test.ts`
- Modify: `docs/handoff/CURRENT_HANDOFF.md`

**Interfaces:**
- The settings form adds one Shangman/智慧印尼 integration section with tenant ID, username, processed password, and complete Basic Authorization fields. Save/clear uses the existing `DesktopSetupInput` action pattern and returns only configured booleans.
- IPC accepts bounded strings, rejects unknown fields, and never adds the production gate or captcha code/image to the public setup schema.

- [ ] Add the navigation section, form model, save/clear paths, status badge, and secret-safe placeholders.
- [ ] Run the required focused Python/Bun/Desktop suites from the repository/worktree root, inspect output and exit codes, run `git diff --check`, scan the diff for secret literals, and update the handoff with branch, files, runtime chain, environment contract, tests, limitations, and the explicit no-commit/no-probe status.
- [ ] Leave the worktree unstaged and uncommitted for the coordinator's explicit submission authorization.
