# Five-Country Mabang Order Import Implementation Plan

**Goal:** Apply the approved transport, latest-date and optional batch rules to all five countries through the existing order-import command.

**Architecture:** Reuse the Indonesia parser and selection workflow. Keep each country's sheet, SKU column, prefix, output naming and existing artifact-field conventions. The existing Brazil/Vietnam and Philippines column parameters resolve duplicate columns for the same transport and batch on the latest date; a valid unambiguous override confirms that selection, while old, absent or wrong-field columns fail explicitly. Selecting one column never suppresses other transports or batches.

**Tech Stack:** Python 3.12, openpyxl, pytest, Bun.

**Spec:** User-approved five-country rules recorded in `docs/record/20261109-mabang-indonesia-order-import-handoff.md`; PR #148 at `aacd3049` is the base. The user subsequently approved adding the four-country changes directly to PR #148.

## Constraints

- All countries scan row 1 for `M/D` plus an optional single ASCII letter plus 陆运, 空运 or 海运. Interpret years using the existing Indonesia policy. Choose the latest date per transport and all batches on that date; one transport is sufficient.
- Output IDs are the existing country prefix and generation date followed by the optional uppercase batch and `-L`, `-K` or `-H`. Preserve SKU rows, template defaults, actual errors, and the existing command and parameter names.
- Duplicate selected fields require correction or a matching existing override; no override can select an older date. Outputs are all cleaned up if any workbook or final validation fails.
- Make no Git status or history changes without approval. Add the completed four-country changes to PR #148 as requested, without changing its pool-10 worktree.

### Task 1: Contract tests

**Files:** `python/lxeskill_cli/tests/mabang/test_mabang_order_import.py`, `test_mabang_order_import_regressions.py`, `order_import_test_helpers.py`.

- [x] Add parameterized real-CLI cases for Brazil, Malaysia, Vietnam and Philippines with independent latest land/air/sea dates, normal plus A/C batches, a single transport, and Brazil headers outside AT:BD. Verify exact files, order IDs, selected headers, SKU order and quantities.
- [x] Test duplicate latest batches with and without the applicable legacy override, wrong/older overrides, and that overriding one batch does not suppress other valid outputs. Retain error, cached-formula, year-boundary, file cleanup and Indonesia regressions; update assertions tied to the superseded country policies.
- [x] Run focused tests before implementation: 11 failed under the previous contract; after implementation these cases passed.

### Task 2: Shared selection and output

**Files:** `python/lxeskill_cli/services/mabang/order_import/country_rules.py`, `workflow.py`.

- [x] Configure all four countries to use the existing transport parser and per-transport latest selector, preserving country-specific identity and existing artifact-field conventions. Remove obsolete selection paths only when no callers remain.
- [x] Validate overrides against the latest candidates and their corresponding field; use them only to resolve duplicate columns or confirm a selected column, never to suppress other fields. Report invalid or ambiguous input explicitly.
- [x] Clean up the entire run directory if any country fails during generation or final file checks. Focused order-import tests: 116 passed.

### Task 3: Contract and handoff

**Files:** `python/lxeskill_cli/lxeskill/catalog.json`, `skills/mabang-order-import-generate/SKILL.md`, generated `docs/lxeskill-cli/commands.md`, `docs/record/20261109-mabang-five-country-order-import-handoff.md`.

- [x] Update legacy parameter descriptions and data set descriptions to explain current behavior; update the existing Skill with the five-country shared rules, country inputs and precise override behavior. The command manual generator reported up to date.
- [x] Run targeted Python order-import and command-contract tests and the Bun command-contract/Skill tests: 528 passed, 4 skipped, 4 warnings with loopback enabled; Bun 16 passed.
- [x] Review the diff, check whitespace and sensitive material, inspect status, and record exact tests, limitations, upstream dependency and pending Git actions in the handoff. Independent review found no confirmed blocking issue; all five original source samples were checked row by row against real CLI output.
