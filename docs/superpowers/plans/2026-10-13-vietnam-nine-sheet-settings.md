# Vietnam Nine-Sheet Settings Implementation Plan

> **For agentic workers:** Execute this plan inline in the current approved feature worktree. The user requested both the plan and the change in this session.

**Goal:** Replace the Vietnam settings page's SKU-map upload controls with upload/export controls for the complete nine-sheet workbook, and keep ERP-only SKUs in the result with missing template parameters blank.

**Architecture:** Reuse the existing `vietnam_full_workbook` input-asset slot so a settings upload becomes the same saved template that the CLI already consumes. Python validates and stores the workbook; Electron only supplies native open/save dialogs; the renderer displays the saved template and its two actions. The existing five-sheet generator continues to accept an explicit SKU map for compatibility, while the nine-sheet path obtains parameters from the template.

**Tech Stack:** Python/openpyxl/OOXML, Electron, React, TypeScript, Bun, uv.

**Spec:** User-confirmed chat requirement and settings-page screenshot from 2026-10-13; the four operational sheets remain unchanged and unmatched ERP SKUs retain source values with dependent cells blank.

## Global Constraints

- Reuse `shared.input_assets` and the current `vietnam_full_workbook` slot; keep real SKU data out of Git.
- Work only in `codex/vietnam-stock-full-workbook`. The user authorized `git add` and commits; push and PR still require separate approval.
- Keep the settings card to two actions: export current template and upload/replace template.
- Continue validating the recalculated five sheets and byte preservation of the four original operational worksheets.

### Task 1: Template settings storage

**Files:** `python/lxeskill_cli/services/vietnam_replenishment/{full_workbook,settings}.py`, `python/lxeskill_cli/tests/vietnam_replenishment/test_settings.py`.

**Interfaces:** `validate_full_template(path)` checks nine visible sheets, expected main headers and preservation support; `settings.read_state()` adds `template` and `template_error`; `settings.upload_template(path)` validates then promotes to `vietnam_full_workbook`; `settings.export_template(destination)` copies the saved current version.

- [x] Add a valid nine-sheet fixture and tests proving upload, reuse by `current_asset`, export byte equality, invalid replacement preserving the current version, and clear error when no version exists.
- [x] Run the targeted tests to confirm the new interfaces initially fail.
- [x] Implement the three settings operations using the existing asset slot and native settings command bridge.
- [x] Run the targeted settings tests again.

### Task 2: ERP-only SKU behavior

**Files:** `python/lxeskill_cli/services/vietnam_replenishment/{asset_contract,workbook,recalculation}.py`, `python/lxeskill_cli/tests/vietnam_replenishment/{test_full_workbook,test_pr5_integration}.py`.

**Interfaces:** `load_template_sku_parameters(path, skus)` returns an empty mapping when no SKU matches; generation permits that empty mapping only for the nine-sheet template path. ERP SKU rows stay present, with missing mapping-dependent results blank.

- [x] Test a template with no matching ERP SKU: all ERP source rows appear, mapped input and dependent formula results are blank, and the nine tabs export successfully.
- [x] Implement the narrow empty-mapping allowance without weakening legacy uploaded-map validation.
- [x] Run the affected Vietnam generator tests.

### Task 3: Desktop settings controls

**Files:** `packages/foundation/desktop-protocol/src/index.ts`, `apps/desktop/src/{ipc-channels,preload-bridge}.ts`, `apps/desktop/src/main/{ipc,main,vietnam-settings}.ts`, `apps/dashboard/src/features/workbench/vietnam-settings-view.tsx`, `apps/dashboard/src/shared/i18n.tsx`, corresponding desktop/dashboard tests.

**Interfaces:** Desktop exposes `uploadVietnamTemplate()` and `exportVietnamTemplate()`; the existing native file dialogs select source/destination; the settings state renders `template` and `template_error`.

- [x] Update tests for exactly two visible template buttons, stored-template status, native dialog cancellation, export success and upload failure.
- [x] Wire the Python settings actions through Electron and change the card copy, status and actions in both locales.
- [x] Run focused Bun tests, dashboard behavior checks and relevant typechecks.

### Task 4: Final review

**Files:** Vietnam Skill, calculation documentation and handoff.

- [x] Describe the first settings upload, later reuse and ERP-only SKU blanks.
- [x] Run the catalog contract checks, `git diff --check`, review changed files and Git status, then update handoff with results and known limits.
- [x] Commit the reviewed work under the user's standing commit authorization; push and PR each need their own approval.
