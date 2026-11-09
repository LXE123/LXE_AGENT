# Indonesia Order Import Implementation Plan

> **2026-11-09 requirements update:** The user subsequently confirmed flexible recognition for all five countries: land/air/sea may appear individually or together; any mode may have an optional single English batch letter; select the latest date independently for each mode and generate one file per batch found on that date. Later dates may be in the future. Use the existing nearest-year interpretation, shared CLI, Skill and template; retain every nonempty SKU and existing file validation. Brazil must eventually scan the full header row. The previous Indonesia-only air+sea requirement and two-to-four-file limit below describe the already-verified earlier version and are superseded.
>
> **Delivery update:** The user requested adding the Indonesia changes directly to PR #148, while preserving the four-country behavior in that PR. Implement the four-country contract change as a separate dependent layer; Git operations require the user's authorization. Review dependent layers serially. Do not create a second Skill, command, tool or workbook-generation workflow.

## Current task: correct the Indonesia layer

- [x] Recognize first-row `M/D` + optional one English batch letter + `陆运`/`空运`/`海运`; retain the parsed date, transport and batch. Normalize letter case consistently and reject a duplicate mode/batch on its latest date rather than overwriting a file.
- [x] For each mode actually present choose its latest date and generate one file for each distinct batch at that date; permit a single mode and reject a table containing no valid transport columns. Order numbers retain `IN{YYMMDD}` followed by the optional batch and `-L`/`-K`/`-H` for land/air/sea.
- [x] Reuse the existing source reader, quantity validation, workbook writer, dataset and CLI. Keep the same artifacts for existing `air`, `sea`, `sea_a` and `sea_b` cases, and extend equivalent metadata for land and other batch letters. Do not change Brazil, Malaysia, Vietnam or Philippines at this layer.
- [x] Extend existing real-CLI tests with sole land/air/sea; A/B/C on each mode; mixed modes with different latest dates; old batches excluded; lowercase; duplicate selected batches; no valid columns; date boundary; all SKU/zero rules; and failure cleanup. Re-run unchanged four-country regressions.
- [x] Re-run the actual Indonesia source workbook through the same CLI under a temporary workspace; compare every SKU/quantity/order/default against source and user samples. Update the existing Skill, generated command documentation if needed, and handoff to distinguish older validation from the revised version.
- [ ] After the Indonesia layer is reviewed, tested and ready, report its Git status and request separately required authorization for staging/commit before creating the dependent four-country branch.

## Later dependent task: four-country contract change

- [ ] Reuse the recognized transport/batch/latest-date behavior in the same existing workflow for Brazil, Malaysia, Vietnam and the Philippines; scan each source header row, including outside Brazil's former AT:BD range, while keeping each country's source sheet, SKU column and order prefix.
- [ ] Explicitly handle existing public selection parameters: never silently ignore an override or use it to select an older date; document/test compatibility or report actual conflicts. Verify changed results against existing real sample evidence and update command contracts, existing Skill and tests. Implement this later layer in a separate branch and worktree, not in PR #148's worktree.

---

> **For agentic workers:** Implement the tasks below with the existing CLI and workbook services; do not create another Skill or standalone command.

**Goal:** Add Indonesia to the existing Mabang order-import workflow while preserving the behavior of the four supported countries.

**Architecture:** Reuse `country_rules`, `source`, `workbook`, `workflow`, the existing command, catalog and Skill. Indonesia selects the most recent air date independently and all available plain/A/B sea columns on the latest sea date, writes all nonempty SKU rows, and uses the bundled workbook template.

**Tech Stack:** Python 3.12, openpyxl, lxeskill catalog, pytest, Bun.

**Spec:** User-confirmed rules in this conversation, 2026-11-09.

## Global Constraints

- Operate only in `codex/mabang-order-import-indonesia` / pool-12; base `6c534f85`.
- Do not add a Skill, separate tool, command, template, dependency, business login, or online order submission.
- Preserve all nonempty textual SKUs, input order and duplicates; leave zero/empty quantity blank; unit price is 0.
- Source sheet `印尼`, SKU column E, header `sku` case-insensitive; use source formulas' saved caches and existing validations.
- Interpret month/day as existing year resolution does; select the latest air date and the latest sea date across unmarked, A and B sea columns. At the latest sea date generate every present mode; reject repeated columns for the same mode on the selected latest date.
- Use `IN{YYMMDD}-K`, `IN{YYMMDD}-H`, `IN{YYMMDD}A-H`, `IN{YYMMDD}B-H` respectively; `YYMMDD` is the current Asia/Shanghai date. Filename `印尼马帮订单导入模板-{order_id}.xlsx`.
- Do not stage, commit, push, create or update a PR without separate user permission. Produce the required handoff.

## Task 1: Country rules and shared workflow

**Files:** `python/lxeskill_cli/services/mabang/order_import/country_rules.py`, `workflow.py`.

- [x] Register `indonesia` with sheet `印尼`, E SKU, shared data reader and template writer. Parse `M/D空运`, `M/D海运`, `M/DA海运`, and `M/DB海运`, recognize ordinary sea distinctly from A/B, and select air independently from the maximum date across all sea modes. Fail explicitly for missing air or sea, malformed dates, and repeated same-mode columns on a selected date.
- [x] Produce air first followed by the selected sea modes in deterministic plain/A/B order. Retain the existing artifact keys and initialize a country dataset directory; on any multi-file failure, including final checks, remove the run directory.
- [x] Keep the existing Brazil/Malaysia/Vietnam/Philippines branches, inputs and outcomes unchanged.

## Task 2: Existing CLI and documentation

**Files:** `python/lxeskill_cli/services/commands/mabang/order_import_generate.py`, `python/lxeskill_cli/lxeskill/catalog.json`, `skills/mabang-order-import-generate/SKILL.md`, generated `docs/lxeskill-cli/commands.md`.

- [x] Extend the current country enum, dataset and help description. Keep Indonesia on the existing command and Skill; do not add a separate selectable shipping override without an established need.
- [x] Document latest air/latest grouped sea selection, any combination of sea modes, full SKU preservation, orders and file names.
- [x] Run the existing documentation generator from the repository root and verify it affects only the expected documentation.

## Task 3: Meaningful tests and real sample verification

**Files:** `python/lxeskill_cli/tests/mabang/order_import_test_helpers.py`, `test_mabang_order_import.py`, `test_mabang_order_import_regressions.py`.

- [x] Add a source fixture with `印尼`/E SKU, old `10/15A海运` and `10/15B海运`, newer `11/6海运` and `11/6空运`; assert the existing CLI returns `IN261105-K` and `IN261105-H`, all 3 source SKU rows including a duplicate, zero/blank quantities left blank and unchanged template defaults.
- [x] Add grouped cases for latest A+B with older plain, latest single A or B, and same-day plain+A+B, asserting precisely which outputs are created and their quantities; add latest-vs-nearest dates and cross-year interpretation cases.
- [x] Assert missing/duplicated transport columns fail truthfully without publishing files, invalid selected cells propagate, and multi-file failure cleans all output files. Keep four-country tests intact.
- [x] Run `uv run --frozen pytest python/lxeskill_cli/tests/mabang/test_mabang_order_import.py python/lxeskill_cli/tests/mabang/test_mabang_order_import_regressions.py python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` and `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` from pool-12 root. Record counts and skips.
- [x] Run the real CLI on the supplied 1.69 GB Indonesia source with artifact/data roots under `/private/tmp`; validate 8,577 rows per file, source SKU order and quantities against BB/BG and the corresponding supplied H/K files. Sample files include only positive quantity rows; compare those rows separately without discarding the rest from generated output. Do not access the network or submit orders.

## Task 4: Review and handoff

- [x] Independently review requirements, unchanged existing-country behavior, date grouping, failure cleanup, sensitive information, scope and tests. Resolve confirmed issues.
- [x] Inspect `git diff`, `git diff --check`, and `git status`, then write a handoff recording branch, changed files, entry points, environment, verification, limitations, PR #148 dependency and next step.
- [ ] Report actual checks and NOT VERIFIED items; request authorization for staging/commit only after the module is ready.
