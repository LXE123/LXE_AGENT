# Business Contract Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Yacang, Shangman/Wisdom Indonesia, Zhihui TMS, and Mabang Brazil exports accurate through one structured Skill contract while removing platform-specific Runtime routing and Tool duplication.

**Architecture:** Keep every existing platform exporter, login, pagination, download, workbook validation, and Yacang merge implementation intact. Converge the boundaries around them: Skills produce structured arguments, Python adapters expose compact terminal data, the existing question system handles generic confirmation and sensitive pending input, and the normal Agent path owns Skill selection. Delete the Zhihui pre-turn path and the Shangman-named captcha Tool only after their generic replacements pass behavior tests.

**Tech Stack:** Bun 1.4.2, TypeScript, Python 3.12 via uv, pytest, Bun test, Electron/React Dashboard, JSONL lxeskill protocol.

**Spec:** `docs/superpowers/specs/2026-09-21-business-contract-convergence-design.md`

## Global Constraints

- Work only on `feature-amazon-replenish-multi-platform`; never switch to or develop on `main`.
- Preserve `MY8801`, `PH8805`, `TH8802`, `VN8806` as the single ordered Yacang warehouse set.
- Yacang inventory and sales support one warehouse, any valid subset, and omitted-as-all-four.
- Yacang inbound/listing runs once with `warehouse_scope=all`; it never creates per-warehouse inbound files.
- Do not change platform HTTP endpoints, authentication, pagination, download, workbook validation, retry, rate-limit, or risk-control behavior.
- Do not add a global router, four-platform Skill, Mabang Brazil top-level Skill, or platform-specific pre-turn filter.
- Do not persist credentials, captcha images, captcha answers, tokens, cookies, or secrets in terminal data, transcripts, logs, tests, or Git.
- Any Git index, commit, rebase, merge, or push operation requires explicit user approval; push requires a separate confirmation.
- Use `uv` for Python and `bun` for JavaScript/TypeScript; run tests from the repository root.

---

### Task 1: Lock the Yacang warehouse and inbound contracts

**Files:**
- Modify: `skills/yacang-export-workflow-map/SKILL.md`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Modify: `python/lxeskill_cli/services/yacang/export_intent.py`
- Modify: `python/lxeskill_cli/services/yacang/export_workflow.py`
- Modify: `python/lxeskill_cli/tests/yacang/test_export_intent.py`
- Modify: `python/lxeskill_cli/tests/yacang/test_export_workflow.py`
- Modify: `python/lxeskill_cli/tests/yacang/test_cli_boundaries.py`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py`

**Interfaces:**
- Consumes: `WAREHOUSE_CODES`, `normalize_structured_intent(...)`, `plan_export_workflow(...)`.
- Produces: one exact structured input shape using `values: list[str]`; per-warehouse tasks for inventory/sales; one `global/all` task for inbound/listing.

- [x] **Step 1: Add failing tests for one, many, and all four warehouses**

Add parameterized planner assertions equivalent to:

```python
@pytest.mark.parametrize(
    ("values", "expected"),
    [
        (["VN8806"], ["VN8806"]),
        (["MY8801", "VN8806"], ["MY8801", "VN8806"]),
        (["VN8806", "MY8801"], ["MY8801", "VN8806"]),
    ],
)
def test_structured_inventory_sales_uses_fixed_warehouse_order(values, expected):
    normalized = normalize_structured_intent(
        data_type_intent={"state": "resolved", "values": ["inventory-sales"]},
        warehouse_intent={"state": "resolved", "values": values},
        created_date_filter={"state": "omitted"},
        inventory_snapshot_intent={"state": "omitted"},
        today=lambda: date(2026, 9, 21),
    )
    plan = plan_export_workflow(normalized, execution_date="2026-09-21")
    assert [task["warehouse"] for task in plan["logical_tasks"]] == expected
```

Add the same selection matrix for `inventory-current-snapshot`, plus an omitted-warehouse assertion for all four fixed codes.

- [x] **Step 2: Run the Yacang intent and workflow tests and confirm the new assertions fail where the contract is incomplete**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/yacang/test_export_intent.py \
  python/lxeskill_cli/tests/yacang/test_export_workflow.py
```

Expected: existing tests pass; new inbound canonical-scope and exact structured-shape assertions fail before implementation.

- [x] **Step 3: Add failing inbound-only and mixed-request tests**

Assert all inbound-only variants produce the same plan:

```python
assert plan["logical_tasks"] == [{
    "task_id": "inbound-listing-time:global",
    "data_type": "inbound-listing-time",
    "scope": "global",
    "warehouse_scope": "all",
    "status": "not_run",
    "effective_parameters": {},
}]
```

Cover omitted, one warehouse, two warehouses, and all four warehouses. Add a mixed case with `inventory-sales + inbound-listing-time` and `MY8801 + VN8806`; assert two inventory-sales tasks plus one global inbound task.

- [x] **Step 4: Canonicalize inbound-only effective scope without changing mixed warehouse selection**

In both raw compatibility and structured normalization paths, apply this rule after data types are known:

```python
inbound_only = data_types == ["inbound-listing-time"]
if inbound_only:
    intent["warehouse_intent"] = {"state": "omitted"}
    warehouses = list(WAREHOUSE_CODES)
```

Do not apply the reset when inventory or sales is also selected. Keep the planner's inbound task free of warehouse parameters.

- [x] **Step 5: Make the Skill and catalog show the exact plural-array contract**

Add exact single- and multi-warehouse examples to `SKILL.md`. In `catalog.json`, retain only `values` for resolved selection objects and describe inbound as global/all even when the user names one or more warehouses. Do not add a `value` compatibility property.

- [x] **Step 6: Add CLI regression coverage for the observed `value` failure**

Test that:

```python
bad = {"state": "resolved", "value": "inventory-sales"}
good = {"state": "resolved", "values": ["inventory-sales"]}
```

The first returns a specific shape error before production execution and the second reaches normal planning.

- [x] **Step 7: Run Yacang and catalog tests**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/yacang/test_export_intent.py \
  python/lxeskill_cli/tests/yacang/test_export_workflow.py \
  python/lxeskill_cli/tests/yacang/test_cli_boundaries.py \
  python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py
```

Expected: PASS; no production network calls.

- [x] **Step 8: Review the diff, update the handoff, and request approval for the Task 1 commit**

Proposed commit after approval:

```bash
git add skills/yacang-export-workflow-map/SKILL.md \
  python/lxeskill_cli/lxeskill/catalog.json \
  python/lxeskill_cli/services/yacang/export_intent.py \
  python/lxeskill_cli/services/yacang/export_workflow.py \
  python/lxeskill_cli/tests/yacang/test_export_intent.py \
  python/lxeskill_cli/tests/yacang/test_export_workflow.py \
  python/lxeskill_cli/tests/yacang/test_cli_boundaries.py \
  python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py
git commit -m "fix: converge yacang warehouse intent contract"
```

---

### Task 2: Make Mabang Brazil status language canonical

**Files:**
- Modify: `skills/replenishment-workflow-map/SKILL.md`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Modify: `python/lxeskill_cli/services/mabang/brazil_overseas/intent.py`
- Modify: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`

**Interfaces:**
- Consumes: model-resolved `warehouse` and `export_kind`.
- Produces: one validated `BrazilExportKind`; complete Skill/catalog synonym documentation without a Runtime keyword filter.

- [x] **Step 1: Add failing table-driven contract tests for every required phrase**

Add a fixture table in the test module:

```python
EXPECTED_STATUS_PHRASES = {
    "allocation_pending_default_3m": ("未签", "未签收", "待签", "待签收", "还没签收", "尚未签收"),
    "allocation_signed_before_3m": ("已签", "已签收", "已经签收", "签收完成"),
}
```

Assert every phrase and its canonical enum occur together in the Skill contract and catalog description. Assert `allocation_both` is reserved for document requests with no status.

- [x] **Step 2: Run the Mabang intent and Skill documentation tests and confirm missing phrases fail**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py \
  python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py
```

Expected: FAIL on the missing `未签收`, `还没签收`, `尚未签收`, or `已经签收` contract text.

- [x] **Step 3: Align Skill and catalog descriptions without adding a prose parser**

Update both contract surfaces to contain the same phrase table. Keep `validate_brazil_export_parameters(...)` limited to the four canonical enum values; document in its docstring that natural-language translation belongs to the selected Skill, not a global Runtime filter.

- [x] **Step 4: Add ambiguous-boundary assertions**

Assert the Skill explicitly requires clarification for bare `签收`, `调拨`, and platform-ambiguous `单据`, while plain Brazil-overseas `单据/调拨单据` maps to `allocation_both` only when warehouse context is already explicit.

- [x] **Step 5: Run the complete Brazil-overseas test slice**

Run:

```bash
uv run pytest -q python/lxeskill_cli/tests/mabang/test_brazil_overseas_*.py \
  python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py
```

Expected: PASS; no production calls.

- [ ] **Step 6: Review the diff, update the handoff, and request approval for the Task 2 commit**

Proposed commit after approval:

```bash
git add skills/replenishment-workflow-map/SKILL.md \
  python/lxeskill_cli/lxeskill/catalog.json \
  python/lxeskill_cli/services/mabang/brazil_overseas/intent.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py \
  python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py
git commit -m "fix: canonicalize brazil allocation status terms"
```

---

### Task 3: Add a compact terminal-data boundary and preserve business errors

**Files:**
- Modify: `python/lxeskill_cli/lxeskill/business.py`
- Modify: `python/lxeskill_cli/lxeskill/cli.py`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py`
- Modify: `python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py`

**Interfaces:**
- Consumes: full business payloads with optional `terminal_data: dict[str, Any]`.
- Produces: artifact paths derived from the full payload, model-visible `data` derived from `terminal_data`, and a specific top-level error code.

- [ ] **Step 1: Write failing tests for projection and artifact preservation**

Create a fake payload equivalent to:

```python
payload = {
    "success": True,
    "artifact_path": str(artifact),
    "headers": ["large", "internal", "details"],
    "terminal_data": {
        "platform": "fixture",
        "business_type": "export",
        "row_count": 42,
    },
}
```

Assert `files == [str(artifact)]`, visible data contains only the three compact fields, and `headers`, `artifact_path`, and `terminal_data` do not leak into visible data.

- [ ] **Step 2: Write failing tests for business error-code precedence**

Cover both shapes:

```python
{"success": False, "error": {"code": "captcha_expired", "message": "expired"}}
{"success": False, "code": "tms_export_busy", "exception": "busy"}
```

Assert the top-level codes are `captcha_expired` and `tms_export_busy`, with `business_cli_failed` used only when neither shape supplies a code.

- [ ] **Step 3: Run the boundary tests and verify they fail**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py \
  python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py
```

Expected: FAIL because current `_finalize_payload` exposes the full payload and always emits `business_cli_failed`.

- [ ] **Step 4: Implement the optional compact projection**

Add a focused helper in `business.py`:

```python
def _visible_terminal_data(payload: dict[str, Any]) -> dict[str, Any]:
    projected = payload.get("terminal_data")
    if projected is None:
        return payload
    if not isinstance(projected, dict):
        raise RuntimeError("business terminal_data must be an object")
    return dict(projected)
```

Collect declared artifacts and infer success from the full payload before serializing `_visible_terminal_data(payload)`.

- [ ] **Step 5: Implement specific error-code selection**

Use this precedence:

```python
nested_error = payload.get("error")
code = (
    str(nested_error.get("code") or "") if isinstance(nested_error, dict) else ""
) or str(payload.get("code") or "") or "business_cli_failed"
```

Keep the existing true, sanitized error message selection.

- [ ] **Step 6: Run the boundary tests**

Run the Step 3 command again. Expected: PASS.

- [ ] **Step 7: Review the diff, update the handoff, and request approval for the Task 3 commit**

Proposed commit after approval:

```bash
git add python/lxeskill_cli/lxeskill/business.py \
  python/lxeskill_cli/lxeskill/cli.py \
  python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py \
  python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py
git commit -m "refactor: define compact business terminal results"
```

---

### Task 4: Migrate the four business adapters to compact terminal data

**Files:**
- Modify: `python/lxeskill_cli/services/agent_cli/yacang/export_workflow.py`
- Modify: `python/lxeskill_cli/services/agent_cli/shangman/_workflow.py`
- Modify: `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`
- Modify: `python/lxeskill_cli/services/agent_cli/mabang/brazil_overseas_export.py`
- Modify: `python/lxeskill_cli/tests/yacang/test_cli_boundaries.py`
- Modify: `python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`
- Modify: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py`

**Interfaces:**
- Consumes: Task 3 `terminal_data` projection.
- Produces: compact, platform-specific summaries while retaining full raw path fields for artifact validation.

- [ ] **Step 1: Add failing adapter tests for allowed terminal keys**

For successful file results, require these visible summaries:

```python
{
    "platform": "yacang",
    "business_type": "inventory-sales",
    "scope": "warehouses",
    "warehouses": ["MY8801", "PH8805", "TH8802", "VN8806"],
    "overall_status": "success",
    "row_count": 10688,
}
```

Use equivalent compact fields for Shangman, Zhihui, and Mabang. Assert visible terminal data excludes `params`, `intent`, `plan`, `headers`, raw response bodies, absolute artifact path fields, and debug diagnostics on success.

- [ ] **Step 2: Add failure and partial-success tests**

Require only recovery-relevant fields: `overall_status`, `warehouse_scope`, `partial_pages`, `partial_rows`, `auth_refresh_required`, and sanitized diagnostics when applicable. Assert a success payload never contains `pending`, `processing`, or `next_action=continue`.

- [ ] **Step 3: Run the four adapter test slices and confirm failures**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/yacang/test_cli_boundaries.py \
  python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py \
  python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py
```

Expected: FAIL because adapters currently expose full result payloads.

- [ ] **Step 4: Add one adapter-local projector per business**

Each adapter returns the existing full payload plus `terminal_data`. Example shape:

```python
return {
    **full_payload,
    "terminal_data": {
        "platform": "shangman_indonesia",
        "business_type": "goods_export",
        "scope": "platform_export",
        "status": "completed",
        "row_count": full_payload.get("row_count"),
    },
}
```

Do not move platform-specific result interpretation into `business.py`.

- [ ] **Step 5: Run adapter and lxeskill envelope tests**

Run the Step 3 command plus:

```bash
uv run pytest -q python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py
```

Expected: PASS.

- [ ] **Step 6: Measure controlled terminal sizes**

Run preview/disabled-production commands only, save no credentials, and record JSON byte sizes in the handoff. Each migrated result must be smaller than its audited baseline unless an explicit recovery field explains the increase.

- [ ] **Step 7: Review the diff, update the handoff, and request approval for the Task 4 commit**

Proposed commit after approval:

```bash
git add python/lxeskill_cli/services/agent_cli/yacang/export_workflow.py \
  python/lxeskill_cli/services/agent_cli/shangman/_workflow.py \
  python/lxeskill_cli/services/agent_cli/zhihui/export_products.py \
  python/lxeskill_cli/services/agent_cli/mabang/brazil_overseas_export.py \
  python/lxeskill_cli/tests/yacang/test_cli_boundaries.py \
  python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py \
  python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py
git commit -m "refactor: compact four-platform export results"
```

---

### Task 5: Replace the Shangman-named captcha Tool with generic pending input

**Files:**
- Modify: `packages/foundation/desktop-protocol/src/dashboard-rpc.ts`
- Modify: `packages/foundation/desktop-protocol/test/user-questions.test.ts`
- Modify: `packages/agent/runtime/src/tooling/user-questions.ts`
- Delete: `packages/agent/runtime/src/tooling/shangman-captcha.ts`
- Modify: `packages/agent/runtime/test/tooling/user-questions.test.ts`
- Delete: `packages/agent/runtime/test/tooling/shangman-captcha.test.ts`
- Modify: `apps/agent-cli/src/runtime-host.ts`
- Modify: `apps/agent-cli/src/dashboard-service.ts`
- Modify: `apps/dashboard/src/api/queries.ts`
- Modify: `apps/dashboard/src/main.tsx`
- Create: `apps/dashboard/src/features/sessions/pending-sensitive-input.tsx`
- Delete: `apps/dashboard/src/features/sessions/shangman-captcha.tsx`
- Modify: `python/lxeskill_cli/services/shangman/captcha_channel.py`
- Modify: `python/lxeskill_cli/services/agent_cli/shangman/_workflow.py`
- Modify: `python/lxeskill_cli/tests/shangman/test_captcha_channel.py`
- Modify: `python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py`
- Modify: `skills/shangman-goods-export-workflow-map/SKILL.md`

**Interfaces:**
- Consumes: existing `UserQuestionService`, Dashboard question panel, and one-time loopback challenge behavior.
- Produces: generic `PendingSensitiveInput`, a second `ask_user_question` input mode, generic RPC/environment names, and no `shangman_captcha` Tool definition.

- [ ] **Step 1: Add protocol tests for a generic sensitive image input**

Define a platform-neutral shape equivalent to:

```ts
type PendingSensitiveInput = {
  request_id: string;
  kind: "image_text";
  prompt: string;
  image_data_url: string;
  sensitive: true;
};
```

Test generic `sessions.pending_input.answer` validation and remove assertions for `sessions.shangman_captcha.answer`.

- [ ] **Step 2: Add failing runtime tests for the pending-input mode of `ask_user_question`**

Exercise:

```ts
{ pending_input_id: "opaque-request-id" }
```

Assert the tool waits, returns only `{ accepted: true, request_id }`, rejects unknown/expired IDs, handles cancellation, and never returns the sensitive answer or image.

- [ ] **Step 3: Add failing transcript and UI tests**

Assert the Dashboard renders the image and input box from generic pending state, while runtime transcript/tool-result serialization contains neither `image_data_url` nor the submitted answer.

- [ ] **Step 4: Run focused protocol/runtime/UI tests and confirm failures**

Run:

```bash
bun test \
  packages/foundation/desktop-protocol/test/user-questions.test.ts \
  packages/agent/runtime/test/tooling/user-questions.test.ts \
  apps/dashboard/test/features/sessions/user-question-history.test.tsx
```

Expected: FAIL until the generic pending-input contract exists.

- [ ] **Step 5: Extend the existing question service instead of registering another Tool**

Add a pending-input broker behind `registerUserQuestionTool(...)`. The tool schema must accept exactly one of `questions` or `pending_input_id`; the latter waits on an existing challenge and returns acceptance metadata only.

- [ ] **Step 6: Rename protocol, Dashboard, and local-channel concepts generically**

Replace Shangman-named RPC fields, components, and environment names with pending-input equivalents. Keep platform knowledge inside `services/shangman/captcha_channel.py`; the generic host must not inspect Shangman names or business semantics.

- [ ] **Step 7: Migrate the Shangman Skill recovery instructions**

When the CLI returns `user_input_required` plus `request_id`, instruct the Agent to call the existing `ask_user_question` Tool in pending-input mode, then rerun the identical export command once after acceptance.

- [ ] **Step 8: Delete the platform-specific Tool only after migration tests pass**

Remove `registerShangmanCaptchaTool`, `ShangmanCaptchaBroker`, its Tool test, and `shangman-captcha.tsx`. Verify `rg -n 'shangman_captcha|sessions\.shangman_captcha' apps packages python skills` returns no production references.

- [ ] **Step 9: Run focused Python and TypeScript tests**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/shangman/test_captcha_channel.py \
  python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py
bun test \
  packages/foundation/desktop-protocol/test/user-questions.test.ts \
  packages/agent/runtime/test/tooling/user-questions.test.ts \
  apps/dashboard/test/features/sessions/user-question-history.test.tsx
```

Expected: PASS; no sensitive answer in output.

- [ ] **Step 10: Review the diff, update the handoff, and request approval for the Task 5 commit**

Proposed commit after approval:

```bash
git add packages/foundation/desktop-protocol/src/dashboard-rpc.ts \
  packages/foundation/desktop-protocol/test/user-questions.test.ts \
  packages/agent/runtime/src/tooling/user-questions.ts \
  packages/agent/runtime/src/tooling/shangman-captcha.ts \
  packages/agent/runtime/test/tooling/user-questions.test.ts \
  packages/agent/runtime/test/tooling/shangman-captcha.test.ts \
  apps/agent-cli/src/runtime-host.ts apps/agent-cli/src/dashboard-service.ts \
  apps/dashboard/src/api/queries.ts apps/dashboard/src/main.tsx \
  apps/dashboard/src/features/sessions/pending-sensitive-input.tsx \
  apps/dashboard/src/features/sessions/shangman-captcha.tsx \
  python/lxeskill_cli/services/shangman/captcha_channel.py \
  python/lxeskill_cli/services/agent_cli/shangman/_workflow.py \
  python/lxeskill_cli/tests/shangman/test_captcha_channel.py \
  python/lxeskill_cli/tests/shangman/test_goods_export_workflow.py \
  skills/shangman-goods-export-workflow-map/SKILL.md
git commit -m "refactor: generalize sensitive user input"
```

---

### Task 6: Move Zhihui TMS onto the normal Agent path

**Files:**
- Modify: `skills/zhihui-tms-product-export/SKILL.md`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Modify: `python/lxeskill_cli/services/zhihui_tms/intent.py`
- Modify: `python/lxeskill_cli/services/zhihui_tms/planner.py`
- Modify: `python/lxeskill_cli/services/agent_cli/zhihui/export_products.py`
- Create: `python/lxeskill_cli/services/agent_cli/zhihui/preview_products.py`
- Create: `python/lxeskill_cli/services/agent_cli/zhihui/execute_products.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py`
- Modify: `packages/agent/runtime/src/engine/runtime.ts`
- Modify: `packages/agent/runtime/src/engine/types.ts`
- Modify: `packages/agent/runtime/src/tooling/lxeskill-command.ts`
- Modify: `packages/agent/runtime/src/tooling/coding/exec-tools.ts`
- Modify: `packages/agent/runtime/src/tooling/coding/public-types.ts`
- Modify: `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`
- Modify: `packages/agent/runtime/test/tooling/coding-tools.test.ts`
- Modify: `packages/agent/runtime/test/engine/runtime.test.ts`
- Modify: `apps/agent-cli/src/runtime-host.ts`
- Delete: `packages/agent/runtime/src/operations/zhihui-parameter-translator.ts`
- Delete: `packages/agent/runtime/src/operations/zhihui-confirmation.ts`
- Delete: `packages/agent/runtime/src/operations/zhihui-parameters.ts`
- Delete: `packages/agent/runtime/test/operations/zhihui-parameter-translator.test.ts`
- Delete: `packages/agent/runtime/test/operations/zhihui-confirmation.test.ts`
- Delete: `packages/agent/runtime/test/operations/zhihui-parameters.test.ts`
- Delete: `docs/superpowers/specs/2026-09-18-zhihui-ai-parameter-routing-design.md`
- Delete: `docs/superpowers/specs/2026-09-17-zhihui-tms-confirmation-router-design.md`

**Interfaces:**
- Consumes: normal Skill discovery, structured lxeskill arguments, existing `ask_user_question`, and the Task 3 terminal contract.
- Produces: separate preview/execute command contracts, one normal Agent route, no extra translation Provider call, and a catalog-driven generic confirmation gate before execute.

- [ ] **Step 1: Add failing Python tests for the structured Zhihui schema**

Use this exact input:

```json
{
  "platform": "zhihui_tms",
  "warehouse": "PH",
  "intent": "product_export",
  "fields": ["inventory"]
}
```

Use the same structured object for both commands:

```text
lxeskill tms philippines products-export preview --platform zhihui_tms --warehouse PH --intent product_export --fields '["inventory"]'
lxeskill tms philippines products-export execute --platform zhihui_tms --warehouse PH --intent product_export --fields '["inventory"]'
```

Reject wrong platform, wrong warehouse, wrong intent, empty fields, duplicate fields, unknown fields, and extra keys before constructing a network client.

- [ ] **Step 2: Split preview and execute into exact catalog command paths**

Create two catalog entries with command paths ending in `preview` and `execute`. Both use the same fixed input schema. Add thin Python wrappers that call a shared `run_action(arguments, action="preview" | "execute")`; remove public raw `request` parsing and broad keyword acceptance such as treating bare `菲律宾` as sufficient business intent.

- [ ] **Step 3: Add a generic command-confirmation fixture to Runtime tests**

The normal Agent test sequence must be:

```text
read zhihui Skill
→ exec products-export preview
→ exec products-export execute
→ generic execution gate displays the existing question card and waits
→ confirmed answer allows the same execute call to start
→ send_files
→ final answer
```

Add a cancellation sequence that stops before execute. Add an adversarial sequence where the model attempts execute without confirmation; the generic execution gate must ask for confirmation or reject the call, never run production silently.

- [ ] **Step 4: Implement exact generic confirmation metadata at the command boundary**

Add this platform-neutral metadata shape to the execute catalog entry and TypeScript catalog loader:

```json
{
  "confirmation": {
    "header": "确认执行",
    "question": "该操作将登录真实业务系统并导出文件，是否继续？",
    "confirm_label": "确认执行导出",
    "cancel_label": "取消"
  }
}
```

Extend `LxeSkillCommandDefinition`, `LxeSkillInvocation`, and `LxeSkillRecoveryCommand` with this metadata. Before `CodingProcessManager.execute(...)`, `exec-tools.ts` calls a platform-neutral `confirmLxeSkillCommand` callback supplied by Runtime Host. The callback uses the existing `UserQuestionService`, binds the answer to the current `sessionId`, `turnId`, `toolCallId`, exact matched command path, and normalized raw command, and consumes the approval once. Cancellation returns a non-error cancelled observation and does not spawn Python. Do not add `if (zhihui)` or keyword checks to Runtime.

- [ ] **Step 5: Update the Skill to use the normal tools**

The Skill must direct the model to call preview, then call execute; the generic catalog-driven gate displays the existing question card before Python starts. After current-turn confirmation, deliver terminal `files` and stop. Include explicit exclusions for bare Philippines, Yacang, Wisdom Indonesia, and Mabang Brazil.

- [ ] **Step 6: Run new Python and Runtime tests and confirm the normal path works before deletion**

Run:

```bash
uv run pytest -q python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py \
  python/lxeskill_cli/tests/zhihui_tms/test_acceptance.py
bun test packages/agent/runtime/test/engine/runtime.test.ts \
  packages/agent/runtime/test/tooling/lxeskill-command.test.ts
```

Expected: PASS with no production network calls.

- [ ] **Step 7: Delete the old pre-turn path and its obsolete design records**

Remove `tryRunZhihuiConfirmation`, the Runtime option, translator/router/parameter modules, Runtime Host assembly, and their tests. Delete the two superseded design documents listed above; the approved convergence spec remains the current design source.

- [ ] **Step 8: Prove no platform-specific global hook remains**

Run:

```bash
rg -n 'tryRunZhihuiConfirmation|ProviderZhihuiParameterTranslator|zhihuiConfirmation|isExplicitZhihuiRequest' \
  packages/agent/runtime/src apps/agent-cli/src
```

Expected: no matches.

- [ ] **Step 9: Run Zhihui, Runtime, and catalog contract tests**

Run:

```bash
uv run pytest -q python/lxeskill_cli/tests/zhihui_tms \
  python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra
bun test packages/agent/runtime/test \
  packages/foundation/desktop-protocol/test \
  apps/agent-cli/test
```

Expected: PASS.

- [ ] **Step 10: Review the diff, update the handoff, and request approval for the Task 6 commit**

Proposed commit after approval:

```bash
git add skills/zhihui-tms-product-export/SKILL.md \
  python/lxeskill_cli/lxeskill/catalog.json \
  python/lxeskill_cli/services/zhihui_tms \
  python/lxeskill_cli/services/agent_cli/zhihui \
  python/lxeskill_cli/tests/zhihui_tms \
  packages/agent/runtime/src packages/agent/runtime/test \
  apps/agent-cli/src/runtime-host.ts \
  docs/superpowers/specs/2026-09-18-zhihui-ai-parameter-routing-design.md \
  docs/superpowers/specs/2026-09-17-zhihui-tms-confirmation-router-design.md
git commit -m "refactor: route zhihui through the normal agent"
```

---

### Task 7: Verify file accuracy, termination behavior, and complexity reduction

**Files:**
- Modify: `packages/agent/runtime/test/engine/runtime.test.ts`
- Modify: `python/lxeskill_cli/tests/yacang/test_export_workflow.py`
- Modify: `python/lxeskill_cli/tests/shangman/test_goods_export.py`
- Modify: `python/lxeskill_cli/tests/zhihui_tms/test_xlsx_delivery.py`
- Modify: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_workflow.py`
- Modify: `HANDOFF.md` only if it is the active tracked handoff; otherwise create/update the project-standard tracked handoff selected during implementation.

**Interfaces:**
- Consumes: all preceding task contracts.
- Produces: evidence that selected warehouses, generated workbooks, terminal envelopes, and next Agent actions are correct.

- [ ] **Step 1: Add workbook-accuracy assertions**

For fixture exports, open generated XLS/XLSX files and assert expected sheets, headers, row counts, and warehouse values. For default Yacang inventory/sales, assert all four codes are represented; for a subset, assert no unselected warehouse appears.

- [ ] **Step 2: Add Agent termination fixture tests**

Feed a compact terminal with `ok=true` and one file to the fake provider sequence. Assert exactly one `send_files` call, no second business `exec`, no transcript search, and a final reply. Add `ok=false` fixtures asserting the specific error is reported without guessed paths or unrelated tools.

- [ ] **Step 3: Run all directly affected test slices**

Run:

```bash
uv run pytest -q \
  python/lxeskill_cli/tests/yacang \
  python/lxeskill_cli/tests/shangman \
  python/lxeskill_cli/tests/zhihui_tms \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_*.py \
  python/lxeskill_cli/tests/lxeskill \
  python/lxeskill_cli/tests/infra
bun test \
  packages/agent/runtime/test \
  packages/foundation/desktop-protocol/test \
  apps/agent-cli/test \
  apps/dashboard/test/features/sessions
```

Expected: PASS.

- [ ] **Step 4: Run type and build checks**

Run:

```bash
bun run typecheck
bun run dashboard:build
```

Expected: PASS.

- [ ] **Step 5: Run structural and sensitive-data scans**

Run:

```bash
rg -n 'tryRunZhihuiConfirmation|ProviderZhihuiParameterTranslator|shangman_captcha|sessions\.shangman_captcha' \
  packages apps python skills
rg -n '(github_pat_|Authorization: Bearer|password-secret|captcha_code)' \
  skills packages apps python docs/superpowers/specs/2026-09-21-business-contract-convergence-design.md
git diff --check
git status --short --branch
```

Expected: no removed-hook matches, no real secret matches, clean diff formatting, and only scoped task changes plus preserved user-owned untracked files.

- [ ] **Step 6: Update the handoff with exact evidence**

Record branch, commit(s), changed files, entry/call chains, environment variables, tests with pass counts, controlled terminal byte sizes, known limitations, and the next operator step. State explicitly that production APIs were not probed during regression tests.

- [ ] **Step 7: Request approval for the final verification/handoff commit**

Proposed commit after approval:

```bash
git add packages/agent/runtime/test/engine/runtime.test.ts \
  python/lxeskill_cli/tests/yacang/test_export_workflow.py \
  python/lxeskill_cli/tests/shangman/test_goods_export.py \
  python/lxeskill_cli/tests/zhihui_tms/test_xlsx_delivery.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_workflow.py \
  HANDOFF.md
git commit -m "test: verify four-platform export contracts"
```

- [ ] **Step 8: Synchronize the latest main only after user approval**

After all scoped commits and a fresh user approval, fetch and rebase/merge according to the repository's current branch policy. If conflicts occur, stop and report exact files before resolving. Do not push without another explicit confirmation.
