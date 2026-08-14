# Retire the repository `data/` template directory

Status: `Accepted`

`data/` was the original place where business staff dropped their own template
workbooks, at fixed paths that the FBA commands read directly. Templates are now
owned by the app: the desktop uploads a file, `promote_asset` makes it the slot's
current version under `var/inputs/<slot>/current/`, and commands resolve it
through the input-asset registry in `catalog.json`. Nothing in the codebase
resolves a path under `data/` anymore.

What was left behind was worse than an empty directory: `data/README.md` still
told people to place `custom_declaration_documents.xlsx`, `invoice_Template.xlsx`
and `export_tax_products.xlsx` at paths no command reads, so following it would
have looked like a broken feature. The three stale workbooks on the maintainer's
machine (last touched May 2026) were confirmed no longer needed.

Removed: the `data/` directory and its README, the `data/**/*.xls*` ignore rules
(the directory is gone, so there is nothing left to ignore), and the doc index
and audit entries pointing at `data/README.md`.

Structure impact: the frozen `ALLOWED_TOP_LEVEL_DIRECTORIES` set in
`test_repo_structure.py` drops `data`. That test enumerates on-disk directories
and skips git-ignored ones, so the directory must stay absent rather than be
ignored back into existence.

Where templates live now: `var/inputs/fba/<slot>/current/`, with one rollback
generation in `previous/`. `var/` is git-ignored and its root is set by
`LXE_DATA_ROOT` (desktop points it at `<project>/var`). Slots are registered in
`python/lxeskill_cli/lxeskill/catalog.json` under `input_assets`; a cold slot is
filled by uploading the workbook in the app, not by copying files into the repo.
