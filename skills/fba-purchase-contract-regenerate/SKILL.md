---
name: fba-purchase-contract-regenerate
description: 按 ERP 采购批次号读取当前有效版本，使用本机记忆的最新采购合同模板重新生成并覆盖该批次的全部正式合同；用户要求重新下载、补生成、换最新模板重出某个 PB 采购批次的正式合同时使用。只读查询 ERP，不创建或替换采购批次。
type: amazon_fba
commands:
  - lxeskill fba purchase contracts-regenerate
---

# FBA Purchase Contract Regenerate

## Hard Rules

- 必须通过 exec 调用 frontmatter 声明的固定 CLI；禁止直接运行 Python 业务模块。
- 本流程对 ERP 只做查询：禁止改用 `fba purchase summary-create`，禁止提交采购意图、库存确认或批次替换参数。
- 只重新生成批次的当前有效版本。批次已取消、没有当前版本或只有历史版本时停止并转述真实错误。
- 合同号、合同日期、税率、本次采购数量和含税单价必须使用 ERP 已保存的数据；不得自行推算或改号。
- 输出会覆盖 `artifacts/fba/purchase_contracts` 中相同合同号和供应商的旧文件。Windows 上文件被 Excel 占用时转述实际错误，不声称已经覆盖。

## Input And Template Asset

- `batch_no`：必填的 ERP 采购批次号，例如 `PB20260723-0001`。
- `contract_template_xlsx`：采购合同模板汇总，是系统记忆的长期资产。平时不要传参数，自动使用“模板与数据源”中的当前版。
- 只有用户在本轮明确上传新版模板时才传 `--contract-template-xlsx "<绝对路径>"`；全部合同生成成功后新版自动升为当前版，失败时不升版。
- 系统没存过合同模板时，CLI 返回 `input_required`，这时才向用户索取。

## Command

默认使用已保存的当前模板：

```text
lxeskill fba purchase contracts-regenerate --batch-no <PB批次号>
```

用户本轮上传新版模板时：

```text
lxeskill fba purchase contracts-regenerate --batch-no <PB批次号> --contract-template-xlsx "<新版采购合同模板汇总.xlsx>"
```

## Result Handling

- `success=true`：将 terminal `files` 一次传给 `send_files(paths=<terminal.files>)`；报告 `batch_no`、`version_no`、`generated_count`，并逐项列出供应商、合同号和文件名。
- 必须转述 `asset_sources.contract_template_xlsx`，明确使用的合同模板文件名及上传日期。
- `purchase_batch_not_current`：说明该批次没有当前有效版本，不能重生成作废或已替换合同。
- `purchase_batch_has_no_current_contracts`：说明当前版本没有新采购合同，通常表示全部由历史库存满足。
- `batch_not_found`：说明 ERP 没有找到该批次号，不要模糊搜索或猜测相近批次。
- `erp_contract_detail_mismatch` 或 `erp_contract_detail_invalid`：转述真实字段诊断并停止，禁止用本地旧文件补齐。
- 失败时转述 `error.code`、`error.message` 和可用的 `http_status/detail`；若 terminal `files` 含已成功覆盖的部分合同，仍发送这些附件并明确其余合同失败。

