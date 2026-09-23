# Wisdom Indonesia Goods Export Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one public Wisdom Indonesia workflow Skill and the deterministic `lxeskill shangman export preview/run` contract that routes all supported business wording to one `goods-export` plan.

**Architecture:** Keep intent normalization and plan construction in the pure `services.shangman.intent` module. Keep thin CLI adapters in `services.agent_cli.shangman.goods_export_preview` and `services.agent_cli.shangman.goods_export_run`; preview never touches the network and run performs preflight checks before invoking the first-stage client. Catalog and Skill metadata both point to the same public Skill and command family.

**Tech Stack:** Python 3.12, JSON Catalog, YAML Skill frontmatter, existing lxeskill module runner, pytest, Bun Catalog loader tests.

**Spec:** User-provided second-stage Wisdom Indonesia ERP contract in the task delegation and `docs/handoff/CURRENT_HANDOFF.md` from stage one.

## Global Constraints

- Every supported monthly sales, 90-day daily sales, inventory, month-end snapshot, inbound-time, and listing-time request becomes one `goods-export` plan.
- Product-facing text must not claim that the source workbook contains 14-day, 90-day daily, or historical month-end fields.
- `preview` is deterministic and makes no external request.
- `run` returns a concrete recoverable preflight state when production enablement, credentials, or captcha input is absent; it never bypasses captcha or permission gates.
- The only public Skill is `shangman-goods-export-workflow-map` with `type: amazon_replenish`.
- No real ERP request is made in tests; no Desktop, enrollment, or production configuration is added in this stage.

### Task 1: Add deterministic intent and planner tests

**Files:**
- Create: `python/lxeskill_cli/services/shangman/intent.py`
- Create: `python/lxeskill_cli/tests/shangman/test_intent.py`

- [x] Test each supported Chinese business wording and standard `goods-export` terminology maps to `intent.type == "goods-export"` and one task of the same type.
- [x] Test the original `request_text` is preserved and no invented date/report fields appear in the plan.
- [x] Test empty input returns `request_text_required`, ambiguous unrelated input returns `needs_clarification`, and clearly unrelated input returns `unsupported_request`.
- [x] Run the new test file and observe the expected import failure before implementation.

### Task 2: Implement the pure intent/planner module

**Files:**
- Modify: `python/lxeskill_cli/services/shangman/intent.py`

- [x] Define stable JSON-safe result payloads for normalized intent, one-task plan, and recoverable failures.
- [x] Match phrases by normalized whitespace and lowercase text, keeping all natural language interpretation in this module.
- [x] Return canonical JSON-safe dictionaries with `intent`, `plan`, `status`, and error fields; never issue HTTP calls or read credentials.
- [x] Run `python/lxeskill_cli/tests/shangman/test_intent.py` and confirm all cases pass.

### Task 3: Add CLI preview/run adapter and tests

**Files:**
- Create: `python/lxeskill_cli/services/agent_cli/shangman/__init__.py`
- Create: `python/lxeskill_cli/services/agent_cli/shangman/_workflow.py`
- Create: `python/lxeskill_cli/services/agent_cli/shangman/goods_export_preview.py`
- Create: `python/lxeskill_cli/services/agent_cli/shangman/goods_export_run.py`
- Create: `python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py`

- [x] Test separate preview/run adapters while preserving the complete `request_text`.
- [x] Test preview never constructs or invokes the HTTP client and returns the same canonical plan for repeated calls.
- [x] Test run returns `status="blocked"` with `production_gate_required` or `captcha_input_required` without external requests when preconditions are absent.
- [x] Test a fully preflighted run with a fake first-stage client returns the single validated artifact path and canonical payload without contacting the ERP.
- [x] Implement environment-only credential loading and production gate checks; do not read Desktop files or introduce a second secrets store.
- [x] Reuse `ShangmanClient` and `ShangmanCredentials` from stage one; keep the adapter responsible for orchestration and public result shaping.
- [x] Run the focused workflow tests.

### Task 4: Extend Catalog and Skill contract

**Files:**
- Modify: `python/lxeskill_cli/lxeskill/business.py`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Create: `skills/shangman-goods-export-workflow-map/SKILL.md`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_command_contracts.py`
- Modify: `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`

- [x] Add exactly two business entries for `shangman export preview` and `shangman export run`, both owned only by `shangman-goods-export-workflow-map`, with `type: amazon_replenish` in the Skill frontmatter.
- [x] Declare `request_text` as the required complete raw input and declare `artifact_path` as a deliverable only for run.
- [x] Add the `services.agent_cli.shangman.` module naming rule to `load_catalog()` so Catalog validation stays strict.
- [x] Document unified source-export semantics, original XLSX delivery, captcha/authorization waiting, and unsupported field claims in the Skill without exposing credentials or direct Python/API instructions.
- [x] Update exact count assertions and add command/Catalog/Skill ownership assertions.
- [x] Run Python lxeskill/infra contract tests and the required Bun `lxeskill-command.test.ts` test.

### Task 5: Update handoff and verify final phase

**Files:**
- Modify: `docs/handoff/CURRENT_HANDOFF.md`

- [x] Record the second-stage branch/Pool, command contract, intent behavior, environment names, preflight states, modified files, known limits, and next-stage work.
- [x] Run the focused shangman tests, the required Python lxeskill/infra tests, the required Bun test, `git diff --check`, sensitive-data scans, and `git status`.
- [x] Stop before `git add` and `git commit`; propose the exact file list and commit message for later user authorization.
