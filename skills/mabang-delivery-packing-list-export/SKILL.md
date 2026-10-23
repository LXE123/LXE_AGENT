---
name: mabang-delivery-packing-list-export
description: 下载马帮 WMS 托运单装箱数据 Excel。用户明确要求装箱数据、托运单 Excel、WMS 下载、原始装箱数据、不要拆分装箱数据，或为 Amazon FBA 创建货件准备装箱 Excel 时使用；不要用于 FBA 发货单、发货单 SKU 数据、发货单表格下载。
type: amazon_fba
commands:
  - lxeskill mabang delivery packing-list export
---

# WMS Box Download

## 输入与依赖

- `delivery_no`：必须是 `SP` 开头的发货单号。
- `split-mode`：按用户选择设置，未说明时先确认。
  - `auto`: 用户说“自动拆分”“按系统默认”“超过 5 箱拆分”。
  - `original`: 用户说“使用原始装箱数据”“原始文件”“不要拆分”“不拆”。
- 通过 `exec` 调用下方 lxeskill 命令，使用命令行选项传参。API 请求和凭据由 CLI 管理，回复使用其脱敏诊断。
- CLI 使用当前配置的马帮账号和有效认证缓存；需要恢复认证时创建独立临时会话，桌面使用 Electron 认证窗口，独立 CLI 使用已绑定的 Chrome/Edge。

## 执行

```text
lxeskill mabang delivery packing-list export --delivery-no <SP单号> --split-mode auto
```

```text
lxeskill mabang delivery packing-list export --delivery-no <SP单号> --split-mode original
```

## 结果处理

只把最后一条 `type="result"` 记录作为 terminal，先看 `ok`；下表业务字段均位于 `data`，附件位于 `files`。

| Result | Meaning | 后续创建货件 `consignment_no` |
|---|---|---|
| `split_mode=original` | 按用户要求保留原始装箱数据；即使超过 5 箱也不拆分 | 原始 `ship_no` |
| `split_mode=auto` 且 `split_required=true` | 超过 5 箱，已按每 5 箱生成拆分文件 | 拆分文件名对应编号，如 `SP2000202021-1` |
| `split_mode=auto` 且 `split_required=false` | 未超过拆分阈值 | 原始 `ship_no` |

- `ok=true`：告诉用户托运单 Excel 已准备好，业务文件路径见 `data.excel_path`。
- terminal `files` 是 CLI 校验并按拆分结果选择的正式交付文件，非空时一次调用 `send_files(paths=<terminal.files>)`。
- 如有 `data.split_excel_paths`，列出这些拆分文件供后续创建货件使用。
- 如有 `data.split_skipped_reason`，简要转述。
- `ok=false`：保留 `error.message` 中的实际诊断，说明已确认的失败阶段和观察结果。实际 WMS 下载返回空内容或空文件（包括非 Excel 报错中响应头和正文均为空）时，向用户确认该单装箱数据在 ERP 中是否仍存在。
- 用户继续创建 Amazon FBA 货件时，切到 `fba-shipment-create`。

认证刷新先读取 FBA `freeToken`，再进入 WMS，因此装箱下载也可能在 `stage=fba_delivery` 失败。认证诊断附在 `error.message` 中，包括 `auth_environment`、阶段和实际异常；等待 token 失败时还有 `details`，可结合 frame、读取次数及 `last_read_error` 判断观察结果。

CLI 已负责认证恢复；认证获取或恢复失败时结束本次尝试并报告诊断。再次刷新会重新提交登录，需用户明确要求后再尝试。
