# Mabang Brazil Overseas Export Implementation Plan

**Goal:** Deliver three Brazil overseas warehouse XLSX exports through the existing replenishment entry: inventory and cumulative sales, all signed allocation documents, and default-three-month pending allocation documents.

**Architecture:** Keep the public user journey inside `amazon_replenish`. A new, small Mabang Brazil workflow converts raw Chinese requests into a fixed `BrazilExportPlan`; an executor then uses the existing Mabang browser-auth state, domain-specific Cookie headers, and artifact registry. Inventory export runs its required search-before-export sequence. Allocation export runs its required search-before-export sequence and obtains `memcacheKey` only from the existing authenticated Cookie material.

**Tech Stack:** Python 3, aiohttp, existing `browser_auth_service`, existing `shared.datasets`, existing lxeskill Catalog and Skill discovery.

## Global Constraints

- Work only on `codex/mabang-brazil-overseas-export`; do not modify `main`.
- Reuse `MABANG_ACCOUNT`, `MABANG_PASSWORD`, browser-auth storage, `MABANG_MEMCACHE_COOKIE_NAME`, and existing `build_private_amz_headers`; do not add secrets or configuration files.
- All timestamps use `Asia/Shanghai` and format filenames as `YYYY-MM-DD_HHmm`.
- Inventory and sales phrases return one source XLSX named `马帮系统-库存-巴西海外仓-<timestamp>.xlsx`.
- The platform source contains cumulative 7/28/42-day sales only. Do not claim 7/15/30 or daily 90-day data.
- Pending allocation uses empty `datepickerfrom` and `datepickerto` to preserve the confirmed page-default three-month scope.
- Query failures, 403, 429, malformed export responses, HTML downloads, unknown export results, and invalid XLSX files stop the workflow. A 401 becomes the existing explicit auth-refresh-required result.
- After every task: run its tests, `git diff --check`, inspect sensitive-data exposure, write a dated handoff note, then request approval before any `git add` or `git commit`.

## Task 1: Intent, plan, filenames, and artifact partition

**Files:**

- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/__init__.py`
- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/contracts.py`
- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/intent.py`
- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/naming.py`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Test: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py`
- Test: `python/lxeskill_cli/tests/infra/test_dataset_registry.py`

**Interfaces:**

```python
class BrazilExportKind(StrEnum):
    INVENTORY_SALES_SNAPSHOT = "inventory_sales_snapshot"
    ALLOCATION_SIGNED_ALL = "allocation_signed_all"
    ALLOCATION_PENDING_DEFAULT_3M = "allocation_pending_default_3m"

@dataclass(frozen=True)
class BrazilExportPlan:
    kind: BrazilExportKind
    warehouse_id: str = "1072376"
    warehouse_label: str = "巴西海外仓"

def normalize_brazil_export_intent(request_text: str) -> BrazilExportPlan | BrazilIntentClarification: ...
def output_filename(plan: BrazilExportPlan, executed_at: datetime) -> str: ...
```

- [ ] Write parameterized tests for sales phrases, inventory phrases, signed phrases, pending phrases, unsupported wording, and timestamped filenames.
- [ ] Verify the tests fail because the Brazil workflow package and dataset registry entry do not exist.
- [ ] Add the immutable plan types and deterministic text normalization.
- [ ] Make all sales terms, including `7天销量` and `日度90天销量`, resolve to `INVENTORY_SALES_SNAPSHOT` with source-data wording in the result.
- [ ] Make signed and pending terms resolve to their separate allocation plans; return a clarification for `入库` or `签收` without a status.
- [ ] Add `replenish_brazil_overseas` to Catalog datasets with directory `replenish/brazil_overseas` and a Chinese description of its three source exports.
- [ ] Implement the filename mapping with `ZoneInfo("Asia/Shanghai")` and the three approved filename prefixes.
- [ ] Run: `uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py python/lxeskill_cli/tests/infra/test_dataset_registry.py`.
- [ ] Write `docs/handoff/2026-09-18-mabang-brazil-overseas-intent.md` with branch, tested interfaces, files, no external-call status, and the next task.
- [ ] Request approval to stage and commit only Task 1 files.

## Task 2: Inventory and cumulative-sales XLSX export

**Files:**

- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/inventory.py`
- Test: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py`

**Interfaces:**

```python
async def export_brazil_inventory_sales_snapshot(
    *,
    executed_at: datetime | None = None,
) -> BrazilExportArtifact: ...
```

- [x] Write fake-session tests asserting the exact sequence: form POST to `warehouse.searchwarehousestock` with `warehouseIdArr=1072376`, then GET to `warehouse.doexportwarehousestock` on the same authenticated session.
- [x] Test that the search form retains confirmed empty fields and includes `isIdn=1`.
- [x] Test 401 maps to `MabangAuthError`; 403 and 429 stop without a retry; HTML, empty bytes, and a corrupt workbook fail before publishing.
- [x] Reuse `get_auth_context`, `build_cookie_header`, `request_headers`, `erp_http_session`, and the registered `replenish_brazil_overseas` directory.
- [x] Validate a downloaded workbook as a ZIP/XLSX before atomically publishing it under the planned Chinese filename.
- [x] Return one structured artifact path and source metadata stating that the workbook is a raw platform export with 7/28/42 cumulative sales fields.
- [x] Run: `uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py`.
- [x] Write `docs/handoff/2026-09-18-mabang-brazil-overseas-inventory.md` with request order, credential source, validation result, and next task.
- [ ] Request approval to stage and commit only Task 2 files.

## Task 3: Signed and pending allocation XLSX export

**Files:**

- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/allocation.py`
- Test: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_allocation.py`

**Interfaces:**

```python
async def export_brazil_allocation(
    kind: Literal[
        BrazilExportKind.ALLOCATION_SIGNED_ALL,
        BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
    ],
    *,
    executed_at: datetime | None = None,
) -> BrazilExportArtifact: ...
```

- [x] Write fake-session tests for the private-amz query followed by the private export request and the resulting `gourl` XLSX download.
- [x] Assert the pending query sends `allocationstatus=2`, `targetwarhouseId=1072376`, `timetype=timeCreated`, and empty date fields; assert the signed query sends status `4` with the same target warehouse and no date filter.
- [x] Assert the export form retains the captured template ID, fixed settings, ordered `fieldlabel` values, ordered map triples, empty `orderIds`, and runtime `memcacheKey` taken from the existing authenticated Cookie.
- [x] Accept only a successful JSON response with a nonempty approved Mabang download URL. Never resubmit on malformed JSON, missing `gourl`, or download uncertainty.
- [x] Verify the returned XLSX, publish the appropriate signed or pending filename, and return one artifact.
- [x] Run: `uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_allocation.py`.
- [x] Write `docs/handoff/2026-09-18-mabang-brazil-overseas-allocation.md` with request contracts, failure semantics, and next task.
- [ ] Request approval to stage and commit only Task 3 files.

## Task 4: CLI, Skill, routing, and end-to-end contracts

**Files:**

- Create: `python/lxeskill_cli/services/mabang/brazil_overseas/workflow.py`
- Create: `python/lxeskill_cli/services/agent_cli/mabang/brazil_overseas_export.py`
- Create: `skills/replenishment-brazil-overseas-export/SKILL.md`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Modify: `skills/replenishment-workflow-map/SKILL.md`
- Modify: `config/skill-labels.json`
- Modify: `docs/harness/skill/current_skill_catalog.md`
- Test: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_workflow.py`
- Test: `python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py`
- Test: `python/lxeskill_cli/tests/lxeskill/test_command_contracts.py`
- Test: `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`

**Interfaces:**

```text
lxeskill replenish brazil-overseas export --request-text "<complete user request>"
```

- [x] Write CLI tests proving request text reaches the deterministic workflow and declared artifacts are delivered only on success.
- [x] Add one Catalog business command owned by `replenishment-brazil-overseas-export`, with one `request_text` input, one deliverable artifact selector, and the existing `amazon_replenish` Skill type.
- [x] Add the Skill with the three recognized request classes, source-data limitation, no-ID/no-Cookie rules, no automatic auth refresh/retry, and file delivery instructions.
- [x] Route Brazil overseas warehouse phrases from `replenishment-workflow-map` to the new Skill without changing existing store-MSKU replenishment behavior.
- [x] Add the Chinese UI label and Catalog inventory entry.
- [x] Run: `uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_workflow.py python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py python/lxeskill_cli/tests/lxeskill/test_command_contracts.py python/lxeskill_cli/tests/infra`.
- [x] Run: `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`.
- [x] Run: `git diff --check` and inspect `git status --short` plus a secret-pattern scan limited to changed files.
- [x] Write `docs/handoff/2026-09-18-mabang-brazil-overseas-entry.md` with completed behavior, CLI, credentials, tests, limitations, and integration notes.
- [ ] Request approval to stage and commit only Task 4 files.

## Integration Checkpoint

- [ ] After the approved final task commit, request approval to fetch and merge the current `main` into `codex/mabang-brazil-overseas-export`.
- [ ] If the merge reports conflicts, stop and report the exact files and conflict shape.
- [ ] If the merge succeeds, rerun the directly affected tests and `git diff --check`; record the result in a final dated handoff document.
- [ ] Do not push, merge into another branch, or release the Pool without explicit approval.
