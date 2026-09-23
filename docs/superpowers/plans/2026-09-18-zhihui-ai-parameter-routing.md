# 智汇 TMS AI 参数翻译路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Replace the hard-coded natural-language matcher for Zhihui TMS product requests with an AI-to-typed-parameters translation step, while preserving code-side validation, confirmation, export safety, and anti-risk controls.

**Architecture:** Add a pure parameter contract/parser for `ZhihuiProductRequest`, then add a runtime translation seam that asks the existing provider for JSON-only output and validates it before routing. The existing `ZhihuiTmsConfirmationRouter` will accept validated parameters and continue to own the fixed Skill command, preview, confirmation, execute, artifact verification, and failure handling.

**Tech Stack:** TypeScript, Bun tests, existing runtime provider abstraction, existing Desktop runtime confirmation route, `zod` only if already present in the runtime dependency graph; otherwise use a local strict validator without adding a dependency.

**Spec:** `docs/superpowers/specs/2026-09-18-zhihui-ai-parameter-routing-design.md`

## Global Constraints

- Only `platform: "zhihui_tms"`, `warehouse: "PH"`, and `intent: "product_export"` are accepted.
- `fields` is limited to `product`, `sku`, `sales`, `inventory`, `inbound`, and `listing`.
- AI output never becomes a shell command, URL, credential, cookie, token, or arbitrary CLI argument.
- Invalid, uncertain, or unavailable translation must not call the Zhihui CLI.
- Preview remains separate from execute; only the explicit confirmation card choice can execute.
- Preserve session reuse, request pacing, account locking, 401/403/429 stop behavior, partial merged XLSX delivery, and error redaction.
- Use `bun` for JavaScript/TypeScript tests and run commands from the repository root.
- Do not run `git add`, `git commit`, or `git push` without explicit user approval.

### Task 1: Add the strict Zhihui parameter contract and validator

**Files:**
- Create: `packages/agent/runtime/src/operations/zhihui-parameters.ts`
- Test: `packages/agent/runtime/test/operations/zhihui-parameters.test.ts`

**Interfaces:**
- Produces `ZhihuiProductRequest` and `parseZhihuiProductRequest(value: unknown): ZhihuiProductRequest | undefined`.
- The parser rejects `null`, arrays, extra top-level keys, missing keys, invalid enum values, empty fields, duplicate fields, and non-string field values.

- [ ] **Step 1: Write failing tests** for the exact accepted object and every rejected shape listed above.
- [ ] **Step 2: Run** `bun test packages/agent/runtime/test/operations/zhihui-parameters.test.ts` and verify the new tests fail because the module does not exist.
- [ ] **Step 3: Implement** the type and pure validator with no provider or filesystem dependency.
- [ ] **Step 4: Run** the same test command and verify all contract tests pass.
- [ ] **Step 5: Run** `bun run --cwd packages/agent/runtime typecheck`.

### Task 2: Add the provider translation seam

**Files:**
- Modify: `packages/agent/runtime/src/engine/types.ts`
- Create: `packages/agent/runtime/src/operations/zhihui-parameter-translator.ts`
- Test: `packages/agent/runtime/test/operations/zhihui-parameter-translator.test.ts`

**Interfaces:**
- Add a narrow `ZhihuiParameterTranslator` interface with `translate(request, signal): Promise<ZhihuiProductRequest | undefined>`.
- The implementation receives a provider-like dependency and sends a minimal system instruction plus the current user text; it does not include credentials or full conversation history unless the runtime already requires sanitized context.
- The provider response is parsed through `parseZhihuiProductRequest`; prose, markdown fences, invalid JSON, and schema violations return `undefined`.

- [ ] **Step 1: Write tests** for valid JSON, `null`, fenced JSON, prose, malformed JSON, unknown keys, wrong platform, wrong warehouse, and abort propagation.
- [ ] **Step 2: Run** the translator test file and verify failure before implementation.
- [ ] **Step 3: Implement** the translator against the existing runtime provider abstraction, using the provider’s existing non-streaming or single-turn path if available; do not add a new HTTP client.
- [ ] **Step 4: Run** the translator tests and typecheck.
- [ ] **Step 5: Confirm** test fixtures contain no real credentials, URLs, cookies, or tokens.

### Task 3: Integrate translation into the Desktop runtime route

**Files:**
- Modify: `packages/agent/runtime/src/engine/runtime.ts`
- Modify: `packages/agent/runtime/src/operations/zhihui-confirmation.ts`
- Modify: `packages/agent/runtime/test/engine/runtime.test.ts`
- Modify: `packages/agent/runtime/test/operations/zhihui-confirmation.test.ts`

**Interfaces:**
- `tryRunZhihuiConfirmation()` calls the translator before the Zhihui route; it no longer calls `matchZhihuiProductRequest()`.
- `ZhihuiTmsConfirmationRouter.handle()` accepts `ZhihuiProductRequest` and uses the fixed command `tms philippines products-export`; parameter fields are metadata for intent validation only and are not interpolated into the command.

- [ ] **Step 1: Add regression tests** proving “查询菲律宾库存” and “查询菲律宾销量” route when the translator returns valid parameters, while generic inventory, order, other-platform, and uncertain requests do not call the CLI.
- [ ] **Step 2: Add a test** proving a valid translation still produces preview first and execute only after `确认执行导出`.
- [ ] **Step 3: Run** the focused runtime and confirmation tests and verify the new tests fail against the old matcher integration.
- [ ] **Step 4: Replace** the pre-model keyword match with the translator result and pass the validated object into the router.
- [ ] **Step 5: Remove** the old natural-language matching dependency and update existing fixtures to return structured parameters.
- [ ] **Step 6: Run** `bun test packages/agent/runtime/test/operations/zhihui-parameters.test.ts packages/agent/runtime/test/operations/zhihui-parameter-translator.test.ts packages/agent/runtime/test/operations/zhihui-confirmation.test.ts packages/agent/runtime/test/engine/runtime.test.ts`.

### Task 4: Preserve provider compatibility and runtime accounting

**Files:**
- Modify: `packages/agent/runtime/src/engine/runtime.ts`
- Modify: `packages/agent/runtime/src/engine/types.ts` only if the translator needs an explicit request type beyond the existing `RuntimeProvider.turn()` contract.
- Test: existing provider compatibility tests plus a focused runtime test.

**Interfaces:**
- The translation request must work with the providers already supported by this repository or explicitly return `undefined` when structured translation is unavailable.
- Translation failures must not enter the normal provider retry loop indefinitely and must not create a production CLI call.

- [ ] **Step 1: Add provider fixture assertions** for the translation request shape and ensure credentials remain in provider configuration only.
- [ ] **Step 2:** Implement the smallest runtime change needed to call the existing `RuntimeProvider.turn()` API with `toolChoice: "none"`, a minimal system prompt, and a single sanitized user message; do not change provider HTTP adapters unless tests prove the existing contract cannot carry the request.
- [ ] **Step 3:** Verify abort, retry count, usage accounting, and ordinary-chat fallback behavior.
- [ ] **Step 4:** Run the affected provider and runtime tests.

### Task 5: Update Skill guidance and handoff documentation

**Files:**
- Modify: `skills/zhihui-tms-product-export/SKILL.md`
- Modify: `docs/superpowers/specs/2026-09-18-zhihui-ai-parameter-routing-design.md`
- Modify: `docs/superpowers/handoffs/2026-09-17-zhihui-tms-confirmation-router.md`

- [ ] **Step 1:** Document the structured parameter contract and state that the model may translate intent but may not invent commands or credentials.
- [ ] **Step 2:** Document the fallback behavior for uncertain or invalid translations.
- [ ] **Step 3:** Add the current branch, changed files, test commands/results, environment assumptions, known limits, and next steps to the handoff document.
- [ ] **Step 4:** Run `git diff --check` and inspect the complete diff for stale keyword-matcher wording.

### Task 6: Final verification and delivery checkpoint

- [ ] **Step 1:** Run focused tests for all changed runtime modules.
- [ ] **Step 2:** Run `bun run --cwd packages/agent/runtime typecheck` and relevant dashboard typecheck if its interfaces changed.
- [ ] **Step 3:** Run `uv run pytest python/lxeskill_cli/tests/zhihui_tms` only if Python/Skill contract files changed in a way that affects CLI behavior.
- [ ] **Step 4:** Run `git diff --check`, `git status --short`, and a sensitive-data scan over the diff.
- [ ] **Step 5:** Report evidence and the exact file list; request separate approval before `git add`/`git commit`. Do not push.
