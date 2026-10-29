---
name: mabang-delivery-export
description: 下载马帮 FBA 发货单 SKU 数据 CSV。用户要求获取、导出、下载 FBA 发货单、发货单 SKU 数据、发货单表格、SP 发货单 CSV 时使用；不要用于 WMS 装箱数据或托运单 Excel。
type: amazon_fba
commands:
  - lxeskill mabang delivery export
---

# FBA Delivery CSV Download

## 输入与依赖

- `delivery_no`：`SP` 开头的发货单号；缺少时先向用户确认。
- 通过 `exec` 调用下方 lxeskill 命令，使用命令行选项传参。API 请求和凭据由 CLI 管理，回复使用其脱敏诊断。
- CLI 使用当前配置的马帮账号和有效认证缓存；需要恢复认证时创建独立临时会话，桌面使用 Electron 认证窗口，独立 CLI 使用已绑定的 Chrome/Edge。

## 执行

```text
lxeskill mabang delivery export --delivery-no <delivery_no>
```

CLI 可能运行几十秒；启动后等待同一次调用完成。

## 结果处理

只把最后一条 `type="result"` 记录作为 terminal，先看 `ok`；业务字段位于 `data`，附件位于 `files`。

- `ok=true`：交付马帮导出的原始 CSV，业务文件路径见 `data.csv_path`。`files` 是 CLI 校验后的交付列表，非空时一次调用 `send_files(paths=<terminal.files>)`。
- `ok=false`：保留 `error.message` 中的实际诊断，说明已确认的失败阶段和观察结果。

认证失败的 `error.message` 包含 `stage`、实际 URL、异常和 `auth_environment`；等待 FBA token 失败还包含 `details`：

- `target_frame_missing`：等待期间没有匹配的页面 frame。
- `storage_read_failed`：读取均失败。
- `storage_value_empty`：有读取完成但未得到 token；结合 `read_error_count` 和 `last_read_error` 查看同时发生的读取异常。

CLI 已负责认证恢复；认证获取或恢复失败时结束本次尝试并报告诊断。再次刷新会重新提交登录，需用户明确要求后再尝试。
