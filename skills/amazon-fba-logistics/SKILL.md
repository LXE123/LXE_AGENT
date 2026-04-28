---
name: amazon-fba-logistics
description: 用固定 CLI 执行 Amazon FBA 物流优选。用户提到物流优选并且发送类似这些（SP260226004 FBA19BY640PC）的编号时，使用这个 skill。
type: amazon_store
---

## When to Use

- 用户要执行 Amazon FBA 物流优选。
- 用户提到“物流优选”“选物流”“物流报价”“算渠道价格”“根据货件和装箱数据选物流”。
- 用户会提供，或当前任务就是先补齐一段 TSV 文本；每行 3 列：
  - `consignment_no`
  - `shipment_no`
  - `destination_address`

## Hard Rules

- 只使用固定 CLI：`python -m services.agent_cli.amazon_logistic.run`
- 不要尝试从 `shipment_no` 自动查询地址。
- 不要自己解析装箱 Excel。
- 不要猜测或改写收货地址。
- 不要猜测装箱文件路径。
- 不要输出本地 md 文件路径，除非用户明确要求。
- CLI 返回什么就按什么解释，不要自己补业务结论。

## Required Input

执行前必须确认用户提供的是一段 TSV 文本，且满足以下条件，缺任何一项都先追问，不要启动 CLI：

- 每行正好 3 列
- 列顺序固定：
  1. `consignment_no`
  2. `shipment_no`
  3. `destination_address`
- 使用 **Tab** 分隔，不是空格，不是逗号
- 同一批次内所有行的 `consignment_no` 必须相同
- 同一批次内 `shipment_no` 不能重复
- TSV 行数必须与装箱文件中的有效箱子数量完全一致
- 系统按顺序一一映射：第 N 行 `shipment_no` 对应装箱文件中序号为 N 的那一个箱子

装箱文件查找规则固定：

- 目录：`services/test_file`
- 文件名：
  - `{consignment_no}.xls`
  - `{consignment_no}.xlsx`

## How to Execute

因为输入是多行 TSV，固定用 PowerShell here-string 执行，不要把多行文本手工拼成一行：

```powershell
$inputText = @'
<tsv_block>
'@
uv run --frozen python -m services.agent_cli.amazon_logistic.run --input-text $inputText
```

不要改模块名，不要改参数名，不要换成别的入口。
