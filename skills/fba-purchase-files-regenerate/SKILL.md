---
name: fba-purchase-files-regenerate
description: 按 ERP 采购批次号读取当前有效版本的冻结数据，重新生成并覆盖采购汇总、全部 SP 备货单和全部正式合同；用户丢失采购文件、要重新下载整批文件或希望用当前合同模板重新出文件时使用。只读查询 ERP，不创建或替换采购批次。
type: amazon_fba
commands:
  - lxeskill fba purchase files-regenerate
---

# FBA Purchase Files Regenerate

## Hard Rules

- 必须通过 exec 调用 frontmatter 声明的固定 CLI；禁止直接运行 Python 业务模块。
- 本流程对 ERP 只做查询：禁止改用 `fba purchase summary-create`，禁止提交采购意图、库存确认或批次替换参数。
- 一次重新生成当前有效版本的采购汇总、全部 SP 备货单和全部正式合同，不拆分文件类型。
- 厂家、型号、原价、采购数量、库存抵扣、合同号和合同日期必须使用 ERP 冻结数据；不得使用本机最新出口退税总表补齐或改写。
- 输出会覆盖原目录中的同名文件。Windows 上文件被 Excel 占用时转述实际错误，不声称已经覆盖。

## Input And Assets

- `batch_no`：必填的 ERP 采购批次号，例如 `PB20260723-0001`。
- `gross_margin`：可选，仅影响重新生成的备货单售价字段；省略时使用 `0.3`。
- `contract_template_xlsx`：采购合同模板汇总，是系统记忆的长期资产。平时不传参数，自动使用“模板与数据源”中的当前版。
- 只有用户本轮明确上传新版模板时才传 `--contract-template-xlsx "<绝对路径>"`；全部文件成功后新版自动升为当前版，失败时不升版。

## Command

```text
lxeskill fba purchase files-regenerate --batch-no <PB批次号>
```

指定新毛利率或新版合同模板时：

```text
lxeskill fba purchase files-regenerate --batch-no <PB批次号> --gross-margin <毛利率> --contract-template-xlsx "<新版采购合同模板汇总.xlsx>"
```

## Result Handling

- `success=true`：将 terminal `files` 一次传给 `send_files(paths=<terminal.files>)`；报告批次号、版本、毛利率和三类文件数量。
- 必须转述 `asset_sources.contract_template_xlsx`，明确使用的合同模板文件名及上传日期。
- 当前版本没有正式合同时，采购汇总和备货单仍正常返回，合同数量为 `0`。
- `purchase_batch_not_current`：说明批次没有当前有效版本，不能恢复作废或已替换文件。
- `purchase_batch_artifact_snapshot_unavailable`：说明 ERP 缺少可信的冻结快照，不得改用本机总表猜测。
- 失败时转述 `error.code`、`error.message` 和可用的 `detail`；若 terminal `files` 含部分成功覆盖的文件，仍发送并明确其余文件失败。
