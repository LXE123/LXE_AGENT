---
name: fba-purchase-contract-fill
description: 根据采购汇总表 xlsx 和用户提供的合同汇总模板 xlsx 填写采购合同。用户要求填写采购合同、根据采购汇总表生成合同、按公司/厂家模板生成合同文件时使用；不要用于生成采购汇总表、备货单、报关资料或 Amazon 创建货件。
type: amazon_fba
---

# FBA Purchase Contract Fill

## Hard Rules

- 只使用固定 CLI。
- 不要手工编辑合同模板，不要手工拆分 Excel。
- 只使用两个输入：采购汇总表 xlsx 和合同汇总模板 xlsx。
- 合同编号本阶段不处理，保留模板原值。
- 找不到厂家对应模板 sheet 时不重跑其它 CLI，转述 warning。

## Required Input

- `purchase_summary_xlsx`: 由 `fba-purchase-summary-create` 生成的采购汇总表。
- `contract_template_xlsx`: 用户提供的合同汇总模板，一个 sheet 对应一个公司/厂家，sheet 名应等于或包含厂家名；必须包含统一的 `附加件明细模板` sheet。
- 缺少任一 xlsx 路径时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_purchase_contracts --purchase-summary-xlsx "<采购汇总表.xlsx>" --contract-template-xlsx "<合同汇总模板.xlsx>"
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户采购合同已填写，并提供 `output_files[*].output_xlsx`。
- 说明输出为每家公司一个 xlsx；每个文件保留对应公司合同 sheet 和 `补充协议附加件明细` sheet。
- 简要转述 `generated_count`、`skipped_manufacturer_count`。
- 如果 `warnings` 非空，必须转述给用户；常见情况是找不到厂家模板 sheet、同一厂家匹配多个 sheet、模板缺少日期/税率/明细表位置。
- 说明日期写运行当天，交货日期写运行当天 + 3 天，税率来自采购汇总表。
- 说明明细表按 `产品名称=合同产品名称`、`单位=单位`、`数量=数量`、`含税单价=原价`、`含税金额=总价` 填写；模板有 `规格型号` 列时才写入 `型号`。
- 说明 `补充协议附加件明细` 从合同汇总模板的 `附加件明细模板` 复制并按同一厂家明细填写；附加件里的采购合同编号也不处理。
- `success=false`：只转述 `exception`；不要自动重新生成采购汇总表，除非用户明确要求。
