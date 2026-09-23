---
name: mabang-brazil-export
description: 导出马帮 ERP 巴西海外仓库存动销、三个月内待签收及三个月前已签收调拨原始文件。支持独立导出或数据准备流程调用；不用于马帮 TMS，也不执行 Amazon 或巴西备货计算。
type: replenishment
commands:
  - lxeskill mabang brazil-overseas export run
---

# 马帮巴西海外仓导出

## 理解范围

- “巴西海外仓”在本功能中指马帮 ERP 的巴西海外仓；复用现有马帮配置，不索取账号、Cookie 或 Token，不套用马帮 TMS 认证。
- 只说“导出巴西数据”时通过已有问答工具询问库存动销、待签收调拨、已签收调拨或所需组合／全部；取消或跳过时停止。
- “库存”“销量”“库存动销”共用 `inventory_sales_snapshot`，不重复导出。平台原表提供 7／28／42 天累计销量，以实际表头说明；不承诺 15／30 天或逐日销量。
- “待签收”使用 `allocation_pending_default_3m`（页面默认三个月内），“已签收”使用 `allocation_signed_before_3m`（页面三个月前）。只说“调拨单据”时选择这两类，并告知两个不同时间范围。时间是平台快捷筛选口径，不擅自解释为签收日期。
- 其他仓库、自定义日期、历史库存或其他销量窗口不支持，先说明限制并确认是否接受现有范围，不默默替换。

## 执行与交付

模型解析参数，使用已有 `exec` 执行唯一命令，例如全部三类：

```text
lxeskill mabang brazil-overseas export run --params '{"reports":["inventory_sales_snapshot","allocation_pending_default_3m","allocation_signed_before_3m"]}'
```

- 只传用户选择的 reports。运行中等待同一次执行，不重复启动，不手写 API 或改脚本绕过错误。
- 只以最后一条 `type="result"` 的 `ok / data / error / files` 判断结果。按实际结果分别说明库存记录数、调拨单据数、文件明细行数、批次数及完整性，不互相替代。
- 库存交付平台原始 XLSX；调拨每批交付平台原始 XLS，可能超过两份文件。不合并、不裁列、不转换格式、不按 SKU 去重或相加，不推断首次入库／上架时间。
- 独立执行将 terminal `files` 交给 `send_files` 一次；由数据准备流程调用时交回入口统一交付。发送成功才称已发送；发送失败只重试附件发送。
- 零记录明确说明没有数据；不能伪造附件。`ok=false` 的部分成功可交付 `files`，必须说明已完成、失败、未执行及缺失范围，不声称全量完成。
- 缺少或失效认证时报告实际诊断和需要恢复马帮 ERP 登录态；不自动登录、刷新或重复提交。其他失败也不自动重跑，用户明确重试后才启动新任务。
