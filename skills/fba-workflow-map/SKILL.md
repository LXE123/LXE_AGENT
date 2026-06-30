---
name: fba-workflow-map
description: FBA 模块路由图。用户询问 FBA skill 关系、FBA 流程、只有 SP 单号该跑哪个、发货单 CSV 和 WMS 装箱 Excel 区别、发票报关流程、采购汇总表生成、备货单生成、物流流程、退税流程时使用；这是路由/解释 skill，不直接执行 CLI。
type: amazon_fba
---

# FBA Workflow Map

本 skill 只负责解释和路由；执行请求必须切到具体业务 skill。

## Terminology

| Term | Meaning | Skill |
|---|---|---|
| FBA 发货单 / 发货单 SKU 数据 / 发货单表格 | 马帮 FBA 发货单导出的 SKU CSV | `fba-shipment-delivery-csv-download` |
| WMS 装箱数据 / 托运单 Excel / 装箱 Excel | 马帮 WMS 托运单装箱数据 | `fba-shipment-wms-box-download` |
| 出口退税总表 | 用户提供的库存 SKU、产品名称、型号、原价、厂家总表 | `fba-purchase-summary-create` / `fba-restock-workbook-create` |
| Amazon FBA 创建货件 | 在 Seller Central 上传装箱并推进四阶段流程 | `fba-shipment-create` |

只有 `SP...` 单号但没有说明“发货单”或“装箱/WMS/托运单”时，先追问用途，不要猜。

## Skill Map

```mermaid
flowchart TD
  A["fba-shipment-delivery-csv-download<br/>FBA 发货单 SKU CSV"] --> B["fba-stock-sku-download<br/>库存 SKU"]
  A --> C["fba-msku-detail-download<br/>MSKU 明细"]
  A --> D["fba-invoice-template-fill<br/>发票导入模板"]

  E["fba-shipment-wms-box-download<br/>WMS 装箱数据"] --> F["fba-shipment-create<br/>Amazon FBA 创建货件"]
  E --> G["fba-logistics-select<br/>物流优选"]
  E --> D
  L["备货单 xlsx"] --> D
  A --> H["fba-customs-declaration-fill<br/>报关资料"]
  E --> H["fba-customs-declaration-fill<br/>报关资料"]
  L["备货单 xlsx"] --> H

  A --> I["fba-export-tax-delivery-summary<br/>发货单退税汇总"]
  J["fba-export-tax-products-manage<br/>退税白名单"] --> I
  K["fba-logistics-rate-import<br/>物流报价导入"] --> G
  A --> M["fba-purchase-summary-create<br/>采购汇总表生成"]
  N["出口退税总表 xlsx"] --> M
  A --> O["fba-restock-workbook-create<br/>备货单生成"]
  N --> O
```

## Entry Decision Table

| User need | Route to |
|---|---|
| 下载 FBA 发货单、发货单 SKU CSV、SP 发货单表格 | `fba-shipment-delivery-csv-download` |
| 下载 WMS 装箱数据、托运单 Excel、装箱 Excel | `fba-shipment-wms-box-download` |
| 创建 Amazon FBA 货件、上传装箱、确认承运人、填追踪号 | `fba-shipment-create` |
| 按发货单准备库存 SKU Excel | `fba-stock-sku-download` |
| 下载 MSKU 明细、发票前准备 MSKU 数据 | `fba-msku-detail-download` |
| 填写 invoice_Template、生成发票导入表 | `fba-invoice-template-fill` |
| 填写报关资料、生成报关单/发票/箱单/合同 | `fba-customs-declaration-fill` |
| 按发货单和出口退税总表生成采购汇总表 | `fba-purchase-summary-create` |
| 按单个发货单和出口退税总表生成备货单 | `fba-restock-workbook-create` |
| 导入物流报价、更新物流价格 | `fba-logistics-rate-import` |
| 物流优选、选物流渠道 | `fba-logistics-select` |
| 维护可退税 SKU 白名单 | `fba-export-tax-products-manage` |
| 统计某个发货单的退税 SKU | `fba-export-tax-delivery-summary` |

## Subflows

| Subflow | Skills |
|---|---|
| 发货单数据 | `fba-shipment-delivery-csv-download` |
| 装箱与货件创建 | `fba-shipment-wms-box-download` -> `fba-shipment-create` |
| 发票资料 | 备货单 + FBA 发货单 CSV + 本地 WMS 装箱数据 -> `fba-invoice-template-fill` |
| 报关资料 | 备货单 + FBA 发货单 CSV + 本地 WMS 装箱数据 -> `fba-customs-declaration-fill` |
| 采购汇总表生成 | FBA 发货单 CSV + 出口退税总表 -> `fba-purchase-summary-create` |
| 备货单生成 | 单个 FBA 发货单 CSV + 出口退税总表 -> `fba-restock-workbook-create` |
| 物流报价与优选 | `fba-logistics-rate-import` -> `fba-logistics-select` |
| 出口退税 | `fba-export-tax-products-manage` -> `fba-export-tax-delivery-summary` |

采购汇总表和备货单都依赖出口退税总表，但输出约束不同：采购汇总表可多 SP 且包含厂家分类 sheet；备货单只允许单 SP 且不生成厂家分类 sheet。

## Answering Rules

- 先说明相关子流程，再指出下一步具体 skill。
- 不从本 skill 运行命令；执行时切到目标业务 skill。
- 用户只给 `SP...` 时，必须区分 FBA 发货单 CSV 和 WMS 装箱 Excel。
