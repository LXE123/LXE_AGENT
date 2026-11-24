# FBA 业务术语与文件对照

本文档对齐桌面 Agent 在 **马帮、马帮 WMS、亚马逊卖家后台、FBA ERP** 四个系统之间协作时的单据编号、业务文件和操作边界。FBA ERP 内部概念（留存库存、FIFO 抵扣、库存批次、对账状态、三套版本号、SKU 映射等）以服务端仓库 `docs/erp/glossary.md` 为准。

## 四个系统里的单据与编号

| 编号 / 单据 | 所属系统 | 在业务里指什么 |
|---|---|---|
| **SP（发货单号）** | 马帮 | 标识一票 FBA 发货计划与发货处理单（形如 `SP260919007`）。同一票货在仓库改号时，ERP 内拆分为 **采购 SP**（建批原单号）和 **装箱 SP**（实发上传单号）。 |
| **托运单号（`consignment_no`）** | 马帮 WMS | WMS 按分箱结果生成的托运单编号。拆箱导出场景会按托运单号分别创建亚马逊货件。 |
| **货件（Amazon Shipment）** | 亚马逊卖家后台 | 在 Seller Central 创建的入库货件，由 `fba-shipment-create` 按托运单推进。**不要把马帮“发货单（SP）”或“托运单”称为“货件”。** |
| **采购批次（`PB`）** | FBA ERP | 一次建单或纯留存独立建单产生的采购批次号，可对应一张或多张 SP。 |

## 常用业务文件与消费方

| 业务文件 / 资产 | 来源 | 实际消费方（谁在用） | 不再用 / 易混提示 |
|---|---|---|---|
| **发货单 CSV**（`artifacts/fba/delivery_csv/<SP>_*.csv`） | `lxeskill mabang delivery export` | **采购汇总、纯留存发货、单 SP 备货单、ERP 实发对账（`fba erp packing-upload`）、报关实发量（`fba customs`）** | 同一张表在装箱前后含义不同（见下方说明）。 |
| **WMS 托运单装箱 Excel** | `lxeskill mabang delivery packing-list export` | **亚马逊建货件（`fba-shipment-create`）、发票模板（`fba invoice fill` 按分箱实发量）、报关资料（仅取箱数与毛重）** | **采购与 ERP 实发对账不再使用**此表。 |
| **备货单 `.xlsx`** | `fba purchase summary-create` / `fba restock workbook-create` 产出 | 交付采购核算；其「汇总表」的售价与 SKU 规则也是下游报关和发票模板的必需输入 | 报关与发票只取上传备货单「汇总表」售价，不手算。 |
| **出口退税总表**（ERP 称“退税总表”） | 用户维护上传的长期记忆资产（`export_tax_master`） | 采购汇总、单 SP 备货单用来匹配库存 SKU 的供应商、型号与含税价格 | **不是** `fba-export-tax` 的“出口退税产品白名单”；纯留存独立发货与 ERP 实发对账不需要此表。 |
| **出口退税产品白名单** | `lxeskill fba export-tax products-import` 维护 | 按 SP 发货单汇总可退税 / 不可退税 SKU（`fba export-tax delivery-summary`） | 与采购用的“出口退税总表”是两张独立表。 |
| **库存 SKU 表 / MSKU 明细 Excel** | `mabang delivery inventory-sku export` / `msku export` | 按 SP 导出的核对与留档明细表 | 不替代 ERP 对账或建货件输入。 |

**为什么 ERP 对账改用发货单 CSV，而不是创建货件用的 WMS 装箱数据？**

历史上马帮 WMS 装箱数据导出曾出现把总数量错分到错误 MSKU 上的情况，导致 ERP 对账结果失真，因此 ERP 实发对账与报关实发量改为读取发货单 CSV。需要注意的是，马帮数据本身在不同环节复用同一列：发货单 CSV 中的 `MSKU发货量` 列在**装箱前是预期/计划发货量**（供采购建单使用），仓库完成装箱并回填马帮后，**同一字段变为实际发货量**（供 ERP 对账使用）。

## 易混编码与易混动作

- **编码三层区分**：`MSKU`（亚马逊销售编码，可为组合装，装箱与发货单按此统计）→ 经 `MSKU 组成` 换算为 **`库存 SKU`**（仓库与 ERP 内部对账、退税白名单的实物编码，文档与 Skill 中应尽量写全称，避免简称“SKU”导致与 MSKU 混淆）→ 对应 **`型号`**（供应商规格维度，采购合同、FIFO 留存抵扣与缺口检查按供应商 ID + 型号汇总）。
- **“上传装箱数据”动作消歧**：
  - 目标是**亚马逊卖家后台**：按托运单创建货件、向卖家后台上传装箱资料、生成多包装箱 Excel → 走 **`fba-shipment-create`**。
  - 目标是**FBA ERP**：按回填后的发货单 CSV `MSKU发货量`（或 `--all-unshipped` 整单不发声明）上传到 ERP 做装箱与库存 SKU 对账及留存结算 → 走 **`fba-purchase`**（对应命令名因历史兼容仍保留为 `lxeskill fba erp packing-upload`，ERP 界面仍称“装箱快照 / 装箱对账”）。
