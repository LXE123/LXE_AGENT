---
name: fba-purchase
description: FBA 采购与 ERP 留存闭环技能：按 SP 发货单生成采购汇总/备货单/合同（支持预览、FIFO 抵扣或不扣库存）、仅用留存库存为已有 SP 独立发货、按 PB 批次重出采购文件、单 SP 备货单兼容生成，以及按发货单 CSV 实发量或整单不发声明上传到 ERP 做装箱与库存 SKU 对账和留存结算；也说明 ERP 期初库存初始化与历史补录的非 Skill 管理员边界。
type: amazon_fba
commands:
  - lxeskill fba purchase summary-create
  - lxeskill fba stock-shipment create
  - lxeskill fba purchase files-regenerate
  - lxeskill fba restock workbook-create
  - lxeskill fba erp packing-upload
references:
  - references/purchase-summary.md
  - references/stock-shipment.md
  - references/files-regenerate.md
  - references/packing-upload.md
  - references/restock-legacy.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# FBA 采购与留存管理

管理 FBA 采购下单、纯留存独立建单、文件重出、单 SP 备货兼容与发货后 ERP 实发对账结算。**执行具体子任务前，先读取对应参考文档。**

## 任务分流表

| 业务需求 | 数据源 → 产出 | CLI 命令 | 参考文档 |
|---|---|---|---|
| 按一批 SP 发货单生成采购汇总、备货单和正式合同（含 `--preview` 只读预览） | 一批本地发货单 CSV + 出口退税总表 + 合同模板 + 毛利率 → ERP 计算采购与 FIFO 抵扣并生成三类文件 | `lxeskill fba purchase summary-create` | [采购汇总与合同](references/purchase-summary.md) |
| 明确仅用 ERP 留存库存为已有 SP 独立创建发货单 | 本地发货单 CSV → ERP 按有效采购记录匹配并扣减留存库存生成批次（不生成本地 Excel） | `lxeskill fba stock-shipment create` | [仅用留存库存发货](references/stock-shipment.md) |
| 按 ERP 采购批次号 `PB...` 重出整批采购文件 | `batch_no` + 可选毛利率/新版合同模板 → 只读 ERP 冻结快照覆盖生成三类文件 | `lxeskill fba purchase files-regenerate` | [按批次重出文件](references/files-regenerate.md) |
| 上传真实发货量到 ERP、申报待装箱 SP 整单不发并做库存 SKU 对账与留存预览/确认 | 发货单 CSV（最新导出或 `--delivery-csv` 修订版）`MSKU发货量`，或 `--all-unshipped` 零实发声明 → 预览确认后写入装箱快照 | `lxeskill fba erp packing-upload` | [实发上传与对账](references/packing-upload.md) |
| 明确只需单个 SP 独立出备货单且不走整批正飞均价（兼容入口） | 单个本地发货单 CSV + 出口退税总表 + 毛利率 → 单 SP 备货单 xlsx（不出合同、不写 ERP） | `lxeskill fba restock workbook-create` | [单 SP 兼容入口](references/restock-legacy.md) |

## 共用数据源与长期资产

- **发货单 CSV**：默认从 `artifacts/fba/delivery_csv/<SP>_*.csv` 取对应 SP 修改时间最新的文件。采购/纯留存建单/备货单缺失 CSV 时直接报错停止，不自动下载；实发上传支持 `--delivery-csv` 传入用户修订版或 `--all-unshipped` 申报待装箱 SP 整单不发（无需 CSV），自动查找缺失时先询问用户同意后再切 `mabang-delivery-data` 下载。
- **长期资产（自动记忆）**：`master_xlsx`（出口退税总表）与 `contract_template_xlsx`（采购合同模板汇总）由系统记住当前版，**平时不要传这两个参数**（`stock-shipment create` 和 `erp packing-upload` 不使用这两个长期资产）。只有用户本轮上传了新版时才传附件下载后的真实绝对路径，CLI 会自动升版并保留旧版回退；缺失时 CLI 返回 `input_required`，此时再向用户索取。成功后必须转述结果中的 `asset_sources.*`（文件名与上传日期）。

## 共用执行与交付规则

- 通过 `exec` 调用声明的 CLI（`--draft` 已删除，不得调用）；不在本地推导库存、留存或合同来源，不手工修改源文件或输出 Excel；ERP 不可用时停止。
- 等待调用完成，只把最后一条 `type="result"` 作为 terminal，先检查 `ok`。
- `ok=true` 且 `terminal.files` 非空时，一次调用 `send_files(paths=<terminal.files>)` 发送交付文件。
- 失败时保留并转述真实 `error.code`、`error.message` 及可用的 `http_status`/`detail`，不用通用提示覆盖。

## 非 Skill 管理边界

- **初始化 ERP 期初库存**（将现有进销存表初始化为历史库存）：属于部署前的一次性管理操作，应说明由后端服务器管理员执行 `lxe-erp-admin opening-inventory`，不执行 Agent Skill。
- **补录历史库存**（ERP 上线前、尚未进入期初库存的历史 SP 剩余库存增量表）：应在 ERP「留存库存」页由管理员使用「补录历史库存」，不执行 Agent Skill。
