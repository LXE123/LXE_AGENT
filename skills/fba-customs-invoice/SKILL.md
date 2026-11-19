---
name: fba-customs-invoice
description: FBA 报关资料与发票导入模板填写：结合上传备货单、发货单 CSV 和 WMS 装箱数据，执行两阶段报关预览与生成（申报要素/报关单/发票/箱单/合同），或按 WMS 分箱实发量填写 invoice_Template 发票导入表。
type: amazon_fba
commands:
  - lxeskill fba customs preview
  - lxeskill fba customs fill
  - lxeskill fba invoice fill
references:
  - references/customs-declaration.md
  - references/invoice-template.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# FBA 报关与发票资料

根据上传备货单、发货单 CSV 和 WMS 装箱数据制作报关资料或发票导入表。**执行具体子任务前，先读取对应参考文档。**

## 报关 vs 发票对比表

| 场景 | 备货单与数据源 | 实发量口径 | CLI 命令 | 参考文档 |
|---|---|---|---|---|
| **报关资料填写** | 一个或多个同目的国备货单（「汇总表」售价）+ **每次预览自动重下**发货单 CSV + 本地 WMS 箱数毛重 | ERP 只读计算实发量（基于发货单 `MSKU发货量`） | 先 `lxeskill fba customs preview` 预览缺货 → 用户确认后 `lxeskill fba customs fill` | [报关资料参考](references/customs-declaration.md) |
| **发票模板填写** | 单个 SP 备货单 + 本地已有发货单 CSV（仅取 `MSKU → 库存 SKU`）+ 本地已有 WMS 装箱 Excel + 库存 SKU 图片 | WMS 分箱 `装箱数量`（按 `箱号 + 汇总表代表 SKU` 写入） | `lxeskill fba invoice fill` | [发票模板参考](references/invoice-template.md) |

## 共用输入、附件分流与长期资产

- **备货单 `.xlsx`**：必须来自当前对话附件下载后的真实绝对路径，文件名须包含 `SP` 单号和目的国。
- **同一消息多 `.xlsx` 附件分流**（拿不准就直接询问用户，不要猜）：
  - 文件名含 `SP` 单号（如 `6.2-SP260601002-新棱镜备货-美国.xlsx`）→ 本次备货单（`--input-xlsx`）。
  - 文件名不含 `SP` 单号 → 对应模板（`--template-xlsx`）。
- **长期资产（自动记忆）**：`customs_template`（报关模板）和 `invoice_template`（发票模板）均由系统记住当前版，**平时不要传 `--template-xlsx`**。只有用户在本轮对话上传了新版模板时才传其真实绝对路径（CLI 自动升为当前版并保留旧版回退）；缺模板时 CLI 返回 `input_required` 再索取。结果中的 `asset_sources.template_xlsx` 必须转述给用户。

## 共用执行与交付规则

- 通过 `exec` 调用声明的 CLI，不手动修改备货单、模板原件或自造计算；等待同一次调用完成，只把最后一条 `type="result"` 作为 terminal。
- 先检查 `ok`；成功时仅将 `terminal.files` 中的正式交付文件一次传给 `send_files(paths=<terminal.files>)`（诊断报告、数量校验报告、库存 SKU 中间文件不主动发送）。
- 失败时保留并转述真实 `error.message` / `exception` 及可用的 `data.context`。
