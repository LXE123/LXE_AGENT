# Current Skill Catalog

Status: `Current`

This page is a navigation inventory, not a second source of runtime prompt truth. The authoritative content remains each repository `skills/*/SKILL.md`; discovery behavior is implemented in `packages/runtime/src/skills.ts`.

## Inventory

The repository currently contains 27 runtime skills:

| Type | Count | Purpose |
| --- | ---: | --- |
| `amazon_fba` | 15 | shipment, logistics, customs, purchase, contract, and export-tax workflows |
| `amazon_replenish` | 9 | inventory snapshots, sales analysis, parameters, and replenishment calculation |
| `default` | 3 | general connector and workbook capabilities |

Counts describe repository skills before per-agent permission and connector filtering.

## Amazon FBA

- `fba-workflow-map`
- `fba-shipment-create`
- `fba-shipment-delivery-csv-download`
- `fba-shipment-wms-box-download`
- `fba-msku-detail-download`
- `fba-stock-sku-download`
- `fba-logistics-select`
- `fba-logistics-rate-import`
- `fba-customs-declaration-fill`
- `fba-invoice-template-fill`
- `fba-purchase-summary-create`
- `fba-restock-workbook-create`
- `fba-purchase-contract-fill`
- `fba-export-tax-products-manage`
- `fba-export-tax-delivery-summary`

Start with `fba-workflow-map` for routing. The individual skills own exact inputs, tool calls, output files, validation reports, and non-retry rules.

## Amazon Replenishment

- `replenishment-workflow-map`
- `replenishment-store-resolve`
- `replenishment-msku-download`
- `replenishment-unlinked-shipment-download`
- `replenishment-amazon-restock-inventory-snapshot`
- `replenishment-real-inventory-report`
- `replenishment-sales-analyze`
- `replenishment-algorithm-config-manage`
- `replenishment-calculate`

Start with `replenishment-workflow-map`. Snapshot and analysis skills prepare explicit artifacts; calculation consumes those artifacts and the selected algorithm configuration.

## Default Skills

- `dws`: DingTalk Workspace operations, subject to local connector visibility.
- `feishu-im-read`: Feishu IM read operations, subject to platform authorization and connector visibility.
- `minimax-xlsx`: general workbook creation and transformation utilities.

## Runtime Visibility

The visible catalog for one turn can be smaller than this page because runtime applies:

- permission-policy skill-type filtering;
- local connector enable/disable state;
- explicit disabled-skill configuration;
- catalog validation and duplicate rejection.

Dashboard skill APIs and the runtime prompt must use the same filtered catalog. A skill appearing in this repository inventory does not imply that every bot can activate it.

## Keeping This Page Current

Update this page when a repository skill is added, removed, renamed, or changes type. Do not copy operational instructions, CLI schemas, selectors, or workbook column contracts here; link readers to the corresponding `skills/<name>/SKILL.md` instead.
