# Current Skill Catalog

This page is a navigation inventory, not a second source of runtime prompt truth. The authoritative content remains each repository `skills/*/SKILL.md`; discovery behavior is implemented in `packages/agent/runtime/src/tooling/skills.ts`.

## Inventory

The repository currently contains 33 top-level workflow and default runtime skills:

| Type | Count | Purpose |
| --- | ---: | --- |
| `amazon_fba` | 14 | shipment, customs, purchase, contract, and export-tax workflows |
| `amazon_replenish` | 13 | inventory snapshots, sales analysis, parameters, replenishment calculation, Yacang exports, Shangman Indonesia goods export, Brazil overseas source exports, and Zhihui TMS product export |
| `amazon_operations` | 2 | listing, keyword, competitor, and public-review analysis |
| `default` | 3 | general connector, workbook and custom Skill creation capabilities |
| `ziniao_browser` | 1 | controlled Ziniao browser lifecycle and page operations |

Counts describe top-level repository skills before per-agent permission and connector filtering. The
bundled Lark CLI contributes another 27 nested connector-specific Skill manifests, so recursive runtime
discovery sees 60 repository manifests in total.

## Amazon FBA

- `fba-workflow-map`
- `fba-shipment-create`
- `fba-shipment-delivery-csv-download`
- `fba-shipment-wms-box-download`
- `fba-erp-packing-upload`
- `fba-msku-detail-download`
- `fba-stock-sku-download`
- `fba-customs-declaration-fill`
- `fba-invoice-template-fill`
- `fba-purchase-summary-create`
- `fba-purchase-files-regenerate`
- `fba-restock-workbook-create`
- `fba-export-tax-products-manage`
- `fba-export-tax-delivery-summary`

Start with `fba-workflow-map` for routing. The individual skills own exact inputs, tool calls, output files, validation reports, and non-retry rules.

## Amazon Replenishment

- `replenishment-workflow-map`
- `replenishment-brazil-overseas-export`
- `replenishment-store-resolve`
- `replenishment-msku-download`
- `replenishment-unlinked-shipment-download`
- `replenishment-amazon-restock-inventory-snapshot`
- `replenishment-real-inventory-report`
- `replenishment-sales-analyze`
- `replenishment-algorithm-config-manage`
- `replenishment-calculate`

`yacang-export-workflow-map`, `shangman-goods-export-workflow-map`, and `zhihui-tms-product-export` also use the `amazon_replenish` permission type.

Start with `replenishment-workflow-map`. Snapshot and analysis skills prepare explicit artifacts; calculation consumes those artifacts and the selected algorithm configuration.

## Amazon Operations

- `amazon-listing-optimizer`: Amazon.com listing analysis, autocomplete keyword research, and competitor discovery.
- `amazon-review-monitor`: one-shot Amazon.com review sampling with product-summary fallback and internal issue themes.

LXE formally maintains these modules' command and failure contracts. Their results come from Amazon public pages and an undocumented autocomplete endpoint, so agents must retain completeness and confidence diagnostics and must not describe the results as Amazon-authorized data. Review-page failures may preserve product-page rating aggregates as a partial result, but they must never be reported as evidence that a product has no reviews.

## Default Skills

- `dws`: DingTalk Workspace operations, subject to local connector visibility.
- `minimax-xlsx`: general workbook creation and transformation utilities.
- `skill-creator`: create or edit reusable user skills through conversation and existing file/exec tools.

## Ziniao Browser

- `ziniao-browser`: controlled store lifecycle, snapshots, navigation, and page interaction.

## Yacang Operations

- `yacang-export-workflow-map` is the only Agent-discoverable Yacang Skill. Its unified command plans three canonical types: `inventory-sales`, `inventory-current-snapshot`, and `inbound-listing-time`.
- `inventory-sales` publishes one complete inventory-sales XLSX artifact. The source workbook retains all 16 original columns: SKU, product name, warehouse, cumulative 3/7/15/30/60/90-day sales, stock, occupied, in transit, frozen, available, stockout quantity, and creation date. One warehouse keeps the validated source workbook byte-for-byte; multiple warehouses merge complete rows into one sheet in fixed warehouse order. The source has no daily sales detail.
- Current inventory remains a per-warehouse snapshot; historical snapshot dates are unsupported because the remote endpoint has no date parameter. Inbound/listing time remains one global warehouse-product export.
- Legacy type-level `sales-monthly`, `sales-90d`, `inventory-month-end`, and inventory-sales commands remain internal compatibility entries, not additional Agent-discoverable natural-language Skills or separate formal sales projections.

## Zhihui TMS

- `zhihui-tms-product-export` owns the Philippines product-export preview and confirmed execution through `lxeskill tms philippines products-export`. Production execution needs the explicitly enabled Desktop integration and valid credentials; preview does not contact the remote service.

## Runtime Visibility

The visible catalog for one turn can be smaller than this page because runtime applies:

- server-verified device skill-type filtering;
- local connector enable/disable state;
- explicit disabled-skill configuration;
- catalog validation and duplicate rejection.

Dashboard skill APIs and the runtime prompt must use the same filtered catalog. A skill appearing in this repository inventory does not imply that every device can activate it.

## Keeping This Page Current

### UI 中文名

`config/skill-labels.json` 是本地与服务器前端共用的官方中文名源，首次覆盖本页的
FBA、备货、亚马逊运营、紫鸟、雅仓和智汇 28 个技能。只用于 UI 展示，不参与 AI 提示词、命令或权限判断。
中文界面按英文 `name` 查名称；英文界面及未知技能保留原名。

新增上述类型的技能时追加中文名，删除技能时保留映射，让历史统计继续可读。
同一 `name` 始终代表同一技能；业务含义改变时使用新标识。更新中文名称会统一影响
新旧统计展示，不改变请求、统计分组或历史记录。已退役但尚未收录的标识显示英文。

服务器仓库使用 `uv run --frozen python scripts/import-skill-labels --agent-root <本仓库路径>`
生成发布快照，再用同一命令加 `--check` 检查并提交生成文件。不要手改服务器快照。
该检查会阻止缺少历史键的旧 checkout 覆盖已有映射。
两端独立发布，不要求客户端同时升级；服务器未更新的新技能暂时显示英文。

Update this page when a repository skill is added, removed, renamed, or changes type. Do not copy operational instructions, CLI schemas, selectors, or workbook column contracts here; link readers to the corresponding `skills/<name>/SKILL.md` instead.
