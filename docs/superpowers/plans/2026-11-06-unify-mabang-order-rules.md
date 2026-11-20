# Unify Mabang Order Import Rules Implementation Plan

> **For agentic workers:** Execute the tasks in this worktree; coordinate ownership of the rule module, workflow and tests. Git staging, commits and pushes require separate user approval.

**Goal:** Consolidate four country rule implementations behind one internal module without changing the shared CLI, Skill or country-specific results.

**Architecture:** A country-rule registry describes each source sheet, SKU column, transport headers and output details. Shared scanning and three selection strategies feed the existing source reader and workbook writer; the existing workflow owns the dataset and failure cleanup.

**Tech Stack:** Python 3.12, openpyxl, pytest, lxeskill CLI, Bun contract checks.

**Spec:** `docs/record/20261106-mabang-philippines-order-import-handoff.md` and the four-country behavior approved in the current conversation.

## Global Constraints

- Brazil scans AT:BD, requires every header, selects one nearest sea column and returns its column as a letter.
- Malaysia selects the latest date group, rejects duplicate fields and requires A sea, B sea and air; output order is A, B, air.
- Vietnam selects one nearest land or sea column. Philippines selects air, A sea and B sea independently and reports all unresolved ties together.
- Philippines output order is air, A, B; blank and zero quantities retain the SKU with a blank quantity; unit price is 0.
- Keep the existing CLI flags, order IDs, filenames, artifact fields, country-specific error behavior and ordinary failure cleanup.
- Source workbooks and generated business files stay outside the repository. No new dependency, Skill or public command.
- Preserve existing uncommitted work; the pre-change diff and new files were backed up under `/private/tmp/lxe-ph-rules-before.4zQw4H/`.

---

### Task 1: One country-rule module

**Files:**
- Create `python/lxeskill_cli/services/mabang/order_import/country_rules.py`.
- Remove `python/lxeskill_cli/services/mabang/order_import/brazil.py`, `malaysia.py`, `vietnam.py`, and `philippines.py` after their behaviors are migrated.
- Modify `python/lxeskill_cli/services/mabang/order_import/workflow.py` to call the unified module.

**Interfaces:** `ShippingCandidate` contains the column number, header, inferred shipping date and field. `select_shipping_columns` takes the country, sheet, generation date and optional column overrides, and returns the selected candidates. `generate_order_workbooks` takes the country, input file, output directory, generation date, template and overrides, and returns artifact metadata. The exact signatures are in `country_rules.py`.

For Brazil and Vietnam, the selected dictionary key is `selected` and `field` is `海运` or `陆运`. For Malaysia and the Philippines, keys and fields are `air`, `sea_a`, and `sea_b` in each country's existing output order. The artifact boundary converts Brazil's column number back to a letter and retains the original country-specific metadata.

- [x] Implement the country registry, header scanner and nearest-one, latest-group and nearest-per-transport strategies in `country_rules.py`; preserve the existing diagnostic strings and deferred year-tie checks.
- [x] Route the workflow through `generate_order_workbooks`, using the existing per-country dataset IDs and preserving its existing cleanup rules.
- [x] Remove the four country modules after all production callers and regression tests have migrated.

### Task 2: Preserve observable behavior

**Files:**
- Modify `python/lxeskill_cli/tests/mabang/test_mabang_order_import.py`.
- Modify `python/lxeskill_cli/tests/mabang/test_mabang_order_import_regressions.py`.
- Keep `python/lxeskill_cli/tests/mabang/order_import_test_helpers.py` as the shared synthetic input builder.

**Representative assertions:**

```python
assert [item["order_id"] for item in malaysia["artifacts"]] == [
    "MY261105A-H", "MY261105B-H", "MY261105-K",
]
assert [item["order_id"] for item in philippines["artifacts"]] == [
    "PH261105-K", "PH261105A-H", "PH261105B-H",
]
assert [item["shipping_column"] for item in philippines["artifacts"]] == [41, 51, 52]
assert brazil["artifacts"][0]["shipping_column"] == "BD"
```

- [x] Migrate tests that import removed modules to `country_rules` and move writer/cleanup fault injection to the unified call sites; retain the CLI assertions and existing Excel cache/precision regressions.
- [x] Add focused cases that distinguish Malaysia's latest group from the closest date, verify Philippines metadata and cross-year selection, and preserve both countries' output order.
- [x] Run from the worktree root: `UV_CACHE_DIR=/private/tmp/lxe-uv-cache-ph PYTHONDONTWRITEBYTECODE=1 uv run --frozen --no-sync pytest -q -p no:cacheprovider python/lxeskill_cli/tests/mabang/test_mabang_order_import.py python/lxeskill_cli/tests/mabang/test_mabang_order_import_regressions.py`.

### Task 3: Full verification and handoff

**Files:**
- Update `docs/record/20261106-mabang-philippines-order-import-handoff.md` with the unified call chain, actual validation and remaining limitations.

- [x] Run the order-import, `tests/lxeskill`, `tests/infra`, and Bun command-contract tests from the worktree root; when local HTTP fixtures are blocked by the sandbox, repeat with the required local-loopback authorization.
- [x] Run the real Philippine source workbook through the CLI in a temporary output directory; compare all SKU rows, quantities, order IDs and unit prices in all three outputs without copying business data into the repository.
- [x] Inspect the complete diff including new files, run `git diff --check`, inspect status and sensitive/unrelated changes, then update the handoff with the measured results. Leave Git staging, commit and push for separate user approval.
