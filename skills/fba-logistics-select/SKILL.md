---
name: fba-logistics-select
description: 用固定 CLI 执行 Amazon FBA 物流优选。用户提到物流优选、选物流、物流报价、算渠道价格，并提供 consignment_no、shipment_no、destination_address 三列 TSV 时使用。
type: amazon_fba
---

# FBA Logistics Select

## Hard Rules

- 只使用固定 CLI。
- 不要从 `shipment_no` 自动查询地址。
- 不要自己解析装箱 Excel，不要猜测装箱文件路径。
- 不要猜测或改写收货地址。
- CLI 返回什么就按什么解释，不要自己补业务结论。

## Required Input

必须确认用户提供 Tab 分隔 TSV，且每行正好 3 列：

1. `consignment_no`
2. `shipment_no`
3. `destination_address`

额外约束：

- 同一批次内所有 `consignment_no` 必须相同。
- 同一批次内 `shipment_no` 不能重复。
- TSV 行数必须与装箱文件有效箱数完全一致。
- 系统按顺序一一映射：第 N 行 `shipment_no` 对应装箱文件序号 N。
- 装箱文件固定查找 `artifacts/mabang_wms_consignment/{consignment_no}.xls|xlsx`。

## Command

多行 TSV 固定用 PowerShell here-string，不要手工拼成一行：

```powershell
$inputText = @'
<tsv_block>
'@
uv run --frozen python -m services.agent_cli.amazon_logistic.run --input-text $inputText
```

## Result Handling

- 只按 CLI 返回内容解释物流优选结果。
- 不要输出本地 md 文件路径，除非用户明确要求。
- 失败时只转述 CLI 错误原文。
