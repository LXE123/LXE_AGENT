# 按 ERP 采购批次号重出采购文件

只读查询 ERP 已有有效批次的冻结数据，一次覆盖重新生成采购汇总、全部 SP 备货单和全部正式合同。不得改用 `summary-create` 另建或替换批次，也不得用本机最新出口退税总表补齐或改写冻结数据。

## 输入与命令

- `--batch-no`：必填 ERP 采购批次号，如 `PB20260723-0001`。
- `--gross-margin`：可选，默认 `0.3`，仅影响重新生成的备货单 `售价` 字段。
- `--contract-template-xlsx`：长期资产；平时不传，仅用户本轮上传新版合同时传绝对路径。全部文件成功后自动升为当前版，任一失败时不升版。

```text
lxeskill fba purchase files-regenerate --batch-no <PB批次号>
lxeskill fba purchase files-regenerate --batch-no <PB批次号> --gross-margin <毛利率> --contract-template-xlsx "<新版采购合同模板汇总.xlsx>"
```

## 结果与错误处理

- `success=true`：调用 `send_files(paths=<terminal.files>)` 交付覆盖生成的全部文件；报告 `batch_no`、版本、毛利率、三类文件数量，并必须转述 `asset_sources.contract_template_xlsx`（文件名及上传日期）。
- 当前版本没有正式合同时，采购汇总和备货单正常返回，合同数量为 `0`。
- `purchase_batch_not_current`：该批次没有当前有效版本，不能恢复作废或已替换文件。
- `purchase_batch_artifact_snapshot_unavailable`：ERP 缺少可信冻结快照，停止并报告，不能用本地总表猜测。
- Windows 文件被 Excel 占用导致覆盖失败时，转述实际错误；若 `terminal.files` 包含部分已成功覆盖的文件，仍交付并明确指出其余文件失败。
