# Current Skill Catalog

This page is a navigation inventory, not a second source of runtime prompt truth. The authoritative content remains each repository `skills/*/SKILL.md`; discovery behavior is implemented in `packages/agent/runtime/src/tooling/skills.ts`.

## Inventory

The repository currently contains 34 top-level workflow and default runtime skills:

| Type | Count | Purpose |
| --- | ---: | --- |
| `amazon_fba` | 14 | shipment, customs, purchase, contract, and export-tax workflows |
| `replenishment` | 14 | Amazon replenishment workflows and Southeast Asia data preparation with Shangman ERP, Yacang and Mabang TMS |
| `amazon_operations` | 2 | listing, keyword, competitor, and public-review analysis |
| `default` | 3 | general connector, workbook and custom Skill creation capabilities |
| `ziniao_browser` | 1 | controlled Ziniao browser lifecycle and page operations |

Counts describe top-level repository skills before per-agent permission and connector filtering. The
bundled Lark CLI contributes another 27 nested connector-specific Skill manifests, so recursive runtime
discovery sees 61 repository manifests in total.

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
- `replenishment-store-resolve`
- `replenishment-msku-download`
- `replenishment-unlinked-shipment-download`
- `replenishment-amazon-restock-inventory-snapshot`
- `replenishment-real-inventory-report`
- `replenishment-sales-analyze`
- `replenishment-algorithm-config-manage`
- `replenishment-calculate`

Start with `replenishment-workflow-map`. Snapshot and analysis skills prepare explicit artifacts; calculation consumes those artifacts and the selected algorithm configuration.

## 东南亚备货

- `mabang-tms-export`（马帮 TMS 数据导出）：当前账号全部仓库、正常商品、全部库存状态；按内部 ID 分批导出，校验接口总数并合并交付，不按 SKU 去重或汇总销量。单任务登录，原始分批文件保留，失败可交付已校验部分。

- `yacang-export`（雅仓数据导出）：三类原始报表，默认四仓、库存动销不限制源表创建日期；多仓不合并。动销“创建日期”与全局产品资料“创建时间”口径不同，不冒称商品建档、入库／上架时间。登录态仅单次任务复用，账号密码由桌面加密配置。部分成功保留成功文件；数据源与上马独立选择，不自动合并。
- `southeast-asia-replenishment-workflow-map`：东南亚备货流程入口，当前衔接上马 ERP、雅仓与马帮 TMS 数据采集与交付；数据整理和备货计算尚未接通，不使用 Amazon 备货计算代替。
- 上马 ERP、雅仓与马帮 TMS 是当前数据来源，按用户选择独立采集；上马登录负责上马认证，雅仓在单次任务内登录。新增数据源的用途、产出和后续消费者在流程入口维护，平台操作规则保留在对应业务 Skill 中。
- Amazon 与东南亚拥有各自流程入口，当前共同使用 `replenishment` 权限域，没有新增权限类型。

- `shangman-login`（`replenishment` 权限）：通过真实验证码登录上马 ERP，保存本地登录态，并支持状态查询与清除。由普通 Agent Loop 使用 `exec`、`read` 和已有问答工具编排，不执行商品导出。
- 在桌面“上马”设置填写 ID、账号和密码。密码加密保存；Token 按马帮方式保存在应用状态目录，过期或凭据变更后重新登录。
- `status` 只检查本地状态，`clear` 只清除本地状态；两者都不代表平台在线验证或远程注销。
- `shangman-goods-export`（`replenishment` 权限）：调用 `lxeskill shangman export run`，复用现有登录态下载一份上马 ERP 当前配置账号可见的商品全量原始 XLSX；没有登录态时先完成登录再继续。库存和销量共用同一份原始商品报表，不新增筛选、历史数据或补货计算。
- 成功结果只交付校验后的原始文件；失败保留实际脱敏诊断，不自动重复提交导出。文件保存在注册的 `shangman/indonesia` 产物目录下，每次执行独立子目录。

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
FBA、备货、亚马逊运营和紫鸟 26 个技能。只用于 UI 展示，不参与 AI 提示词、命令或权限判断。
中文界面按英文 `name` 查名称；英文界面及未知技能保留原名。当前备货名称区分 Amazon 流程与东南亚流程，上马登录和商品导出服务于东南亚数据采集。

新增上述类型的技能时追加中文名，删除技能时保留映射，让历史统计继续可读。
同一 `name` 始终代表同一技能；业务含义改变时使用新标识。更新中文名称会统一影响
新旧统计展示，不改变请求、统计分组或历史记录。已退役但尚未收录的标识显示英文。

服务器仓库使用 `uv run --frozen python scripts/import-skill-labels --agent-root <本仓库路径>`
生成发布快照，再用同一命令加 `--check` 检查并提交生成文件。不要手改服务器快照。
该检查会阻止缺少历史键的旧 checkout 覆盖已有映射。
两端独立发布，不要求客户端同时升级；服务器未更新的新技能暂时显示英文。

Update this page when a repository skill is added, removed, renamed, or changes type. Do not copy operational instructions, CLI schemas, selectors, or workbook column contracts here; link readers to the corresponding `skills/<name>/SKILL.md` instead.
