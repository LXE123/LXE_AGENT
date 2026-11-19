---
name: fba-export-tax
description: FBA 出口退税白名单维护与发货单退税 SKU 汇总：把新增 SKU 导入出口退税产品白名单，或按 SP 发货单统计可出口退税与不可出口退税 SKU 汇总表。
type: amazon_fba
commands:
  - lxeskill fba export-tax products-import
  - lxeskill fba export-tax delivery-summary
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# FBA 出口退税管理

维护可出口退税产品白名单，并按 SP 发货单统计退税与非退税 SKU 汇总。

## 任务分流表

| 业务需求 | 输入 | CLI 命令 | 产出 |
|---|---|---|---|
| **维护出口退税白名单**（仅支持新增 SKU，不支持删改查） | 至少 1 个 SKU（如 `DX260430201`）+ 出口退税产品表 | `lxeskill fba export-tax products-import --sku <sku1> --sku <sku2>` | 校验后生成更新副本并自动升为当前白名单 |
| **统计 SP 发货单退税 SKU** | `SP` 发货单号 + 出口退税产品表（缺本地 CSV 时自动下载；不可退税品名自动通过马帮库存 SKU 导出补全） | `lxeskill fba export-tax delivery-summary --delivery-no <SP>` | 含 `可出口退税` 和 `不可出口退税` 两页的汇总 xlsx |

## 共用长期资产：`products_path`（出口退税产品表）

- 系统会自动记住当前版白名单，**平时不要传 `--products-path`**。
- 只有用户本轮上传了新版白名单时，才追加 `--products-path <附件真实绝对路径>`；系统没存过时 CLI 返回 `input_required`，此时再向用户索取。
- 成功结果中的 `asset_sources.products_path` 必须转述给用户（例如「使用出口退税产品表：xxx.xlsx（07-06 上传）」）。

## 执行细节与结果处理

- 缺少必需的 SKU 或 `SP...` 单号时先追问，不启动 CLI；不手工解析 CSV、修改用户原件或自行请求马帮 API。
- 等待同一次 CLI 调用完成，只读最后一条 `type="result"` 检查 `ok`。
- **白名单导入（`products-import`）**：
  - 已存在或马帮 API 查不到的 SKU 跳过不导入；有新增 SKU 时在受管目录生成更新副本并自动升为当前版（旧版保留回退），无新增不生成副本。
  - `success=true`：报告 `imported_count`、`skipped_duplicate_count`、`skipped_not_found_count`；`backup_path` 非空说明导入前已自动备份（诊断备份不发送）；`output_xlsx` 非空时通过 `send_files(paths=<terminal.files>)` 发送更新文件。
  - `input_asset_update_failed`：转述 `error.message`，发送 `terminal.files` 中的更新文件，并明确系统尚未记住新版。
- **退税汇总（`delivery-summary`）**：
  - `success=true`：提供 `xlsx_path`，通过 `send_files(paths=<terminal.files>)` 交付汇总表（库存 SKU 中间文件不主动发送），说明含 `可出口退税` 和 `不可出口退税` 两个 sheet，可简述 `matched_sku_count`、`unmatched_sku_count`、`stock_name_missing_count`。
- 其他失败时只转述真实 `exception` / `error.message`。
