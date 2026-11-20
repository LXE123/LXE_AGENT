---
name: mabang-delivery-data
description: 按 SP 发货单号从马帮导出 FBA 发货数据，包括发货单 SKU CSV、WMS 托运单装箱 Excel、库存 SKU 表和 MSKU 明细。用户要求下载或导出某张 SP 发货单、装箱数据/托运单 Excel、库存 SKU 表或 MSKU 明细时使用；按店铺下载未关联货件请使用 mabang-store-unlinked-shipments-export。
type: amazon_fba
commands:
  - lxeskill mabang delivery export
  - lxeskill mabang delivery packing-list export
  - lxeskill mabang delivery inventory-sku export
  - lxeskill mabang delivery msku export
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 马帮 FBA 发货数据下载

围绕单个 `SP` 开头的发货单号导出马帮数据。用户只给出 `SP...` 单号且未说明用途时，先确认要导出哪一类文件。

## 导出类型对照表

| 业务需求 | 数据源与依赖 | CLI 命令 | 产出与说明 |
|---|---|---|---|
| FBA 发货单 / 发货单 SKU CSV / 发货单表格 | `SP` 单号 | `lxeskill mabang delivery export --delivery-no <SP>` | `data.csv_path` 原始 CSV（供采购、实发对账、发票、退税使用）；可能耗时几十秒，等待原调用完成。 |
| WMS 装箱数据 / 托运单 Excel / 装箱 Excel | `SP` 单号 + `--split-mode`（`auto` 或 `original`） | `lxeskill mabang delivery packing-list export --delivery-no <SP> --split-mode <auto\|original>` | `data.excel_path` 托运单 Excel（供创建货件、发票、报关使用）；未说明拆分模式时先确认。 |
| 库存 SKU 表 / 库存 SKU Excel | 本地已有发货单 CSV `SKU发货量` 列（不自动下载；缺文件先让用户准备） | `lxeskill mabang delivery inventory-sku export --delivery-no <SP>` | `data.xlsx_paths`；`batch_count > 1` 说明 SKU 较多已分批导出。 |
| MSKU 明细 Excel | 发货单 `MSKU` 列（缺本地发货单时 CLI 自动下载）；按 `店铺 + MSKU` 校验 | `lxeskill mabang delivery msku export --delivery-no <SP>` | `data.xlsx_path`（原 `.xls` 转换后清理）；`shop_mismatch_count > 0` 表示存在 `店铺不一致` sheet。 |

## WMS 装箱拆分与下游货件

- `--split-mode` 取值规则：用户说“自动拆分 / 按系统默认 / 超过 5 箱拆分”用 `auto`；说“使用原始装箱数据 / 原始文件 / 不要拆分 / 不拆”用 `original`。

| Result | Meaning | 后续创建货件 `consignment_no` |
|---|---|---|
| `split_mode=original` | 保留原始装箱数据，超 5 箱也不拆分 | 原始 `ship_no` |
| `split_mode=auto` 且 `split_required=true` | 超过 5 箱，每 5 箱生成拆分文件 | 拆分编号，如 `SP2000202021-1` |
| `split_mode=auto` 且 `split_required=false` | 未超过拆分阈值 | 原始 `ship_no` |

- 如有 `data.split_excel_paths` 列出拆分文件；如有 `data.split_skipped_reason` 简要转述。
- 用户继续创建 Amazon FBA 货件时，切到 `fba-shipment-create`。

## 执行、交付与认证诊断

- 通过 `exec` 调用上表声明的 CLI，参数以 `lxeskill describe <命令>` 为准；CLI 自行管理马帮请求和认证缓存，需要恢复认证时创建独立临时会话（桌面用 Electron 认证窗口，独立 CLI 用已绑定的 Chrome/Edge）。
- 等待同一次调用完成，只把最后一条 `type="result"` 记录作为 terminal：先检查 `ok`，业务字段在 `data`，交付文件在 `files`。
- `ok=true`：向用户提供业务文件路径，若 `terminal.files` 非空，一次调用 `send_files(paths=<terminal.files>)`。
- `ok=false`：保留 `error.message` 中的真实诊断，说明失败阶段与观察结果。
  - WMS 装箱下载返回空内容或空文件（包括非 Excel 报错中响应头和正文均为空）时，向用户确认该单装箱数据在 ERP 中是否仍存在。
  - 认证失败诊断包含 `stage`、URL、异常和 `auth_environment`（WMS 前置刷新 FBA token 时也可能在 `stage=fba_delivery` 失败）；等待 token 失败的 `details` 结合 `frame`、读取次数及 `last_read_error` 判断：`target_frame_missing`（无匹配 frame）、`storage_read_failed`（读取均失败）、`storage_value_empty`（读取完成但 token 为空）。
  - 认证获取或恢复失败时结束本次尝试并报告诊断，不自行重刷；需用户明确要求后再重试。
