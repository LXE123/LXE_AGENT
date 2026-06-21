# Current Skill Catalog

状态：Current

本文按当前 runtime 实际加载的 [`skills/*/SKILL.md`](../../../skills) 整理，不复制完整 prompt。事实来源是 [`agent_runtime.skill_index`](../../../agent_runtime/skill_index.py)、[`agent_runtime.runtime`](../../../agent_runtime/runtime.py)、[`config/permission_policy.yaml`](../../../config/permission_policy.yaml) 和各 skill front matter。

## 加载和可见性

当前 `skill_index` 加载 22 个运行中 skill：

| Type | 数量 | 可见 bot |
| --- | ---: | --- |
| `amazon_fba` | 12 | `AMAZON_FBA`、`LXE_CLAW` |
| `amazon_replenish` | 9 | 备货 bot、`LXE_CLAW` |
| `default` | 1 | `AMAZON_FBA`、备货 bot、`LXE_CLAW` |

`replenishment-amazon-fba-inventory-snapshot` 目前只有 `SKILL.hidden.md`，不会被 `skill_index` 加载，不属于当前运行中 skill。

## Workflow 摘要

FBA 主线：

- `fba-workflow-map` 负责解释 FBA skill 关系和入口选择。
- 发货数据链路区分 FBA 发货单 CSV、WMS 装箱 Excel、库存 SKU、MSKU 明细。
- 创建货件由 `fba-shipment-create` 承接，围绕上传装箱数据、多包装箱 Excel、承运人确认和追踪号阶段推进。
- 发票、报关、物流、退税分别由独立 CLI skill 处理。

Replenishment 主线：

- `replenishment-workflow-map` 负责解释备货 skill 关系和缺数据时的路由。
- 店铺名先由 `replenishment-store-resolve` 解析，再下载 MSKU、销量、真实库存和未关联货件数据。
- `replenishment-template-manage` 管理公式参数，`replenishment-calculate` 汇总销量、库存和未关联货件生成备货建议。
- `replenishment-amazon-restock-inventory-snapshot` 只解析用户手动下载的 Seller Central 补充库存 CSV。

## Archive Mapping

以下运行中 skill 有同名历史材料目录；这些材料只作为维护背景，不是当前 prompt：

- [fba-shipment-create](archive/amazon_fba/fba-shipment-create/)
- [fba-logistics-select](archive/amazon_fba/fba-logistics-select/draft.md)
- [fba-invoice-template-fill](archive/amazon_fba/fba-invoice-template-fill/draft.md)
- [fba-customs-declaration-fill](archive/amazon_fba/fba-customs-declaration-fill/draft.md)
- [fba-msku-detail-download](archive/amazon_fba/fba-msku-detail-download/sanitized_flow.md)
- [fba-stock-sku-download](archive/amazon_fba/fba-stock-sku-download/sanitized_download_step.md)
- [fba-shipment-delivery-csv-download](archive/amazon_fba/fba-shipment-delivery-csv-download/sanitized_api_note.md)
- [fba-export-tax-delivery-summary](archive/amazon_fba/fba-export-tax-delivery-summary/process_draft.md)
- [replenishment-template-manage](archive/amazon_replenish/replenishment-template-manage/customizable_formula_parameter_draft.md)
- [replenishment-sales-analyze](archive/amazon_replenish/replenishment-sales-analyze/draft.md)
- [replenishment-calculate](archive/amazon_replenish/replenishment-calculate/draft.md)
- [replenishment-unlinked-shipment-download](archive/amazon_replenish/replenishment-unlinked-shipment-download/draft.md)
- [replenishment-msku-download](archive/amazon_replenish/replenishment-msku-download/sanitized_store_msku_download_flow.md)
- [replenishment-real-inventory-report](archive/amazon_replenish/replenishment-real-inventory-report/)

## amazon_fba Skills

| Skill | 用途 | 触发场景 | 主要输入/输出 | Runtime source |
| --- | --- | --- | --- | --- |
| `fba-workflow-map` | 解释 FBA skill 关系和流程入口。 | 用户询问 FBA 流程、skill 关系、只有 SP 单号该跑哪个。 | 输入问题上下文；输出路由建议和流程解释。 | [SKILL.md](../../../skills/fba-workflow-map/SKILL.md) |
| `fba-shipment-delivery-csv-download` | 下载马帮 FBA 发货单 SKU 数据 CSV。 | 用户要求下载 FBA 发货单、SP 发货单 CSV、发货单 SKU 数据。 | 输入 SP 发货单号；输出 FBA 发货单 CSV。 | [SKILL.md](../../../skills/fba-shipment-delivery-csv-download/SKILL.md) |
| `fba-shipment-wms-box-download` | 下载马帮 WMS 托运单装箱数据 Excel。 | 用户明确要装箱数据、托运单 Excel、WMS 原始装箱数据。 | 输入托运单或下载条件和 split mode；输出 WMS 装箱 Excel。 | [SKILL.md](../../../skills/fba-shipment-wms-box-download/SKILL.md) |
| `fba-shipment-create` | 完成 Amazon FBA 创建货件流程。 | 用户创建货件、上传装箱数据、确认承运人或输入追踪号。 | 输入店铺/货件上下文、装箱文件和阶段参数；输出阶段结果、文件或下一步指令。 | [SKILL.md](../../../skills/fba-shipment-create/SKILL.md) |
| `fba-msku-detail-download` | 从 FBA 发货单提取 MSKU 并下载马帮 MSKU 明细。 | 用户要 MSKU 明细或为发票资料准备 MSKU 数据。 | 输入 SP 发货单号；输出 MSKU 明细 Excel。 | [SKILL.md](../../../skills/fba-msku-detail-download/SKILL.md) |
| `fba-stock-sku-download` | 按 FBA 发货单 CSV 下载库存 SKU Excel。 | 用户按 SP 单号获取库存 SKU 表或库存数据表。 | 输入本地 FBA 发货单 CSV；输出库存 SKU Excel。 | [SKILL.md](../../../skills/fba-stock-sku-download/SKILL.md) |
| `fba-invoice-template-fill` | 填写发票导入模板。 | 用户上传备货 xlsx 并要求生成发票导入表。 | 输入备货 xlsx；输出填写后的 invoice template。 | [SKILL.md](../../../skills/fba-invoice-template-fill/SKILL.md) |
| `fba-customs-declaration-fill` | 填写报关资料模板。 | 用户要求填写报关单、报关资料、发票、箱单或合同。 | 输入一个或多个备货 xlsx；输出申报要素、报关单明细、发票、箱单、合同。 | [SKILL.md](../../../skills/fba-customs-declaration-fill/SKILL.md) |
| `fba-logistics-select` | 执行 Amazon FBA 物流优选。 | 用户提到物流优选、选物流、物流报价或算渠道价格。 | 输入 consignment_no、shipment_no、destination_address TSV；输出物流优选结果。 | [SKILL.md](../../../skills/fba-logistics-select/SKILL.md) |
| `fba-logistics-rate-import` | 导入物流报价或物流更新 Excel。 | 用户要求导入物流报价表、运行物流更新脚本或更新物流价格。 | 输入物流报价 Excel；输出导入结果。 | [SKILL.md](../../../skills/fba-logistics-rate-import/SKILL.md) |
| `fba-export-tax-products-manage` | 维护出口退税产品白名单。 | 用户要求导入可出口退税 SKU 或更新退税产品列表。 | 输入 SKU 列表或 Excel；输出白名单更新结果。 | [SKILL.md](../../../skills/fba-export-tax-products-manage/SKILL.md) |
| `fba-export-tax-delivery-summary` | 汇总 FBA 发货单出口退税 SKU。 | 用户要求按 SP 发货单统计出口退税产品或生成退税产品 xlsx。 | 输入 SP 发货单或相关发货数据；输出退税 SKU 汇总文件。 | [SKILL.md](../../../skills/fba-export-tax-delivery-summary/SKILL.md) |

## amazon_replenish Skills

| Skill | 用途 | 触发场景 | 主要输入/输出 | Runtime source |
| --- | --- | --- | --- | --- |
| `replenishment-workflow-map` | 解释备货 skill 关系、执行顺序和缺数据路由。 | 用户询问备货流程、先跑哪个、缺什么数据或备货思维导图。 | 输入问题上下文；输出备货流程和下一步建议。 | [SKILL.md](../../../skills/replenishment-workflow-map/SKILL.md) |
| `replenishment-store-resolve` | 解析马帮 Amazon FBA 店铺名到可查询 ID。 | 用户查询店铺 ID、店铺名不完整，或下载店铺数据前需要解析。 | 输入模糊或完整店铺名；输出规范 store_name、store_id 和 id_type。 | [SKILL.md](../../../skills/replenishment-store-resolve/SKILL.md) |
| `replenishment-msku-download` | 下载某店铺 MSKU 数据 Excel。 | 用户要求获取店铺、欧洲整组或欧洲子站点 MSKU 数据。 | 输入 store_name/store_id/id_type；输出店铺 MSKU Excel。 | [SKILL.md](../../../skills/replenishment-msku-download/SKILL.md) |
| `replenishment-sales-analyze` | 基于本地 MSKU 数据生成销量分析报告。 | 用户要求店铺链接销量、ASIN 销量、MSKU 趋势或补货前销量报告。 | 输入规范店铺名和本地 MSKU 数据；输出销量分析报告。 | [SKILL.md](../../../skills/replenishment-sales-analyze/SKILL.md) |
| `replenishment-real-inventory-report` | 生成真实库存报告。 | 用户要求查看店铺 MSKU、本地 SKU、组合 SKU 或备货所需真实库存。 | 输入规范店铺名和本地 MSKU 数据；输出真实库存报告。 | [SKILL.md](../../../skills/replenishment-real-inventory-report/SKILL.md) |
| `replenishment-unlinked-shipment-download` | 下载未关联货件原生导出并生成快照。 | 用户测试下载未关联货件、检查备货缺失货件数据。 | 输入店铺名；输出未关联货件原始文件和快照。 | [SKILL.md](../../../skills/replenishment-unlinked-shipment-download/SKILL.md) |
| `replenishment-template-manage` | 管理备货参数模板。 | 用户查看、导出、校验、导入或保存自定义备货模板。 | 输入模板操作和 xlsx；输出模板文件、校验结果或保存结果。 | [SKILL.md](../../../skills/replenishment-template-manage/SKILL.md) |
| `replenishment-calculate` | 生成店铺 MSKU 备货建议。 | 用户要求计算备货量、补货量、运输方式或链接备货汇总。 | 输入销量分析、真实库存、未关联货件和模板参数；输出备货建议。 | [SKILL.md](../../../skills/replenishment-calculate/SKILL.md) |
| `replenishment-amazon-restock-inventory-snapshot` | 解析 Seller Central 补充库存 CSV。 | 用户使用亚马逊补充库存、需要下载路径指引，或要增加补充库存扣减字段。 | 输入用户手动下载的补充库存 CSV；输出备货可用 snapshot。 | [SKILL.md](../../../skills/replenishment-amazon-restock-inventory-snapshot/SKILL.md) |

## default Skills

| Skill | 用途 | 触发场景 | 主要输入/输出 | Runtime source |
| --- | --- | --- | --- | --- |
| `feishu-im-read` | 读取飞书 IM 历史消息、话题回复和图片/文件资源。 | 用户需要 bot 可见群聊里的历史消息、线程回复或媒体文件。 | 输入飞书会话/消息上下文；输出读取结果或下载资源。 | [SKILL.md](../../../skills/feishu-im-read/SKILL.md) |
