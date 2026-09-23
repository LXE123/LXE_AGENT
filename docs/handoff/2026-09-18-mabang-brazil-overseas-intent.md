# Mabang Brazil Overseas Export — Intent Module Handoff

## Branch and Pool

- Branch: `codex/mabang-brazil-overseas-export`
- Pool: `pool-3`
- Status: `READY_FOR_COMMIT`

## Completed

- Added deterministic normalization for Brazil overseas warehouse inventory/sales, all signed allocation, and default-three-month pending allocation requests.
- Treated sales, requested 7-day windows, and requested daily-90-day wording as one raw inventory export. The plan records that the platform source only contains cumulative 7/28/42-day sales fields.
- Added immutable export kinds, the confirmed warehouse ID, and the registered artifact partition.
- Added Beijing-time filenames:
  - `马帮系统-库存-巴西海外仓-YYYY-MM-DD_HHmm.xlsx`
  - `马帮系统-已签收-巴西海外仓-YYYY-MM-DD_HHmm.xls`
  - `马帮系统-3个月待签收-巴西海外仓-YYYY-MM-DD_HHmm.xls`

## Files Changed

- `python/lxeskill_cli/services/mabang/brazil_overseas/__init__.py`
- `python/lxeskill_cli/services/mabang/brazil_overseas/contracts.py`
- `python/lxeskill_cli/services/mabang/brazil_overseas/intent.py`
- `python/lxeskill_cli/services/mabang/brazil_overseas/naming.py`
- `python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py`
- `python/lxeskill_cli/lxeskill/catalog.json`
- `docs/superpowers/plans/2026-09-18-mabang-brazil-overseas-export.md`

## Entry and Call Chain

`request_text` → `normalize_brazil_export_intent()` → `BrazilExportPlan` → future inventory or allocation executor → registered `replenish/brazil_overseas` artifact directory.

## Environment and Credentials

- No new environment variables or credential storage.
- Future executors must reuse existing Mabang browser-auth state and existing authenticated Cookie extraction.

## Validation

```text
uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py python/lxeskill_cli/tests/infra/test_dataset_registry.py
79 passed
```

## Known Limits

- This phase does not make external requests, create a CLI command, or expose a Skill.
- Inventory and allocation HTTP contracts remain the next two core modules.

## Next Step

Implement the inventory-search-then-export flow with fake-session tests before any real integration probe.
