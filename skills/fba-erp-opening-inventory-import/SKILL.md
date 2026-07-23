---
name: fba-erp-opening-inventory-import
description: 将现有进销存 xlsx 严格解析为可追溯的历史库存批次，先预览再确认导入 FBA ERP。用户要求导入期初库存、迁移人工进销存表、预览库存初始化，或确认之前的期初库存摘要时使用；不要用于日常采购、装箱数据或手工修改 ERP 库存。
type: amazon_fba
commands:
  - lxeskill fba erp opening-inventory-import
---

# FBA ERP Opening Inventory Import

## Hard Rules

- 必须通过 exec 调用 frontmatter 中声明的固定 CLI；禁止直接运行 Python 业务模块。
- 此 Skill 是一次性 ERP 期初化流程；先预览，只有用户明确确认后才能执行写入命令。
- 不要修改用户的 xlsx，不要手工整理或合并行。
- 必须转述 CLI 返回的真实错误码、HTTP 状态和脱敏后明细；不要用通用提示覆盖。
- 只允许独立 `LXE_ERP_API_KEY`；缺少凭据时停止，不要用其他 API Key 替代。

## Required Workbook

第一个 sheet 的第一行必须严格为：

```text
供应商 | 采购订单号 | 订单号 | 型号 | 含税单价 | 数量
```

- `采购订单号` 按历史合同号导入。
- `数量` 按当前仍可用的剩余库存导入，必须大于 0。
- 每个原始数据行保留为独立库存来源，不合并同型号或同合同行。

## Preview

```text
lxeskill fba erp opening-inventory-import --input-xlsx "<进销存表.xlsx>"
```

当 `data.error.code=opening_inventory_confirmation_required` 时：

1. 展示 `data.preview` 中的行数、总数量、供应商数、型号数和警告。
2. 说明导入后 ERP 将把这些行作为 FIFO 历史库存。
3. 询问用户是否确认；未取得明确确认前不要继续。

## Confirm

用户确认后，必须使用预览返回的 `data.source_sha256`：

```text
lxeskill fba erp opening-inventory-import \
  --input-xlsx "<进销存表.xlsx>" \
  --confirm-source-sha256 <source_sha256>
```

- `success=true` 且 `status=created`：报告导入成功和导入行数。
- `status=idempotent`：说明相同请求已安全处理，未重复创建库存。
- `opening_inventory_source_changed`：文件自预览后已变化，必须重新预览和询问。
- `opening_inventory_already_initialized`：转述 ERP 已初始化的真实来源信息，不要重试覆盖。
