---
name: fba-purchase-contract-fill
description: 草稿/兼容入口：根据采购汇总表 xlsx 和用户提供的合同汇总模板 xlsx 填写采购合同，新表使用本次采购量，旧表兼容数量。仅在用户明确要求本地草稿合同或处理旧采购汇总表时使用；正式日常采购应使用 fba-purchase-summary-create 创建 ERP 批次和合同编号。
type: amazon_fba
commands:
  - lxeskill fba purchase contracts-fill
---

# FBA Purchase Contract Fill

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要手工编辑合同模板，不要手工拆分 Excel。
- 只使用两个输入：采购汇总表 xlsx 和合同汇总模板 xlsx。
- 合同编号本阶段不处理，保留模板原值。
- 找不到厂家对应模板 sheet 时不重跑其它 CLI，转述 warning。

## Required Input

- `purchase_summary_xlsx`: 由 `fba-purchase-summary-create` 生成的采购汇总表。
- 新版汇总表按 `本次采购量` 填合同，零采购行跳过；旧版表仍兼容 `数量`。
- `contract_template_xlsx`: 合同汇总模板，一个 sheet 对应一个公司/厂家，sheet 名应等于或包含厂家名；必须包含统一的 `附加件明细模板` sheet。由系统记忆，见下方「长期资产」。
- 缺少 `purchase_summary_xlsx` 时先追问，不要启动 CLI。

## 长期资产（自动记忆）

- `contract_template_xlsx`（采购合同模板汇总）是**长期资产**：系统记住当前版，**平时不要传这个参数**。
- 只有用户在本轮对话里上传了新版本时才传它的绝对路径；CLI 会自动把它升为当前版，旧版留一份可回退。
- 用户没上传、系统也没存过时，CLI 会返回 `input_required`，这时才向用户索取。
- 结果里的 `asset_sources.contract_template_xlsx` 必须转述给用户，例如「使用采购合同模板汇总：xxx.xlsx（文件日期 07-06）」，让用户能发现用错了版本。

## Command

```text
lxeskill fba purchase contracts-fill --purchase-summary-xlsx "<采购汇总表.xlsx>"
```

用户上传了新版本时（只有这种情况才传该参数）：

```text
lxeskill fba purchase contracts-fill --purchase-summary-xlsx "<采购汇总表.xlsx>" --contract-template-xlsx "<新版合同汇总模板.xlsx>"
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户采购合同已填写，并提供 `output_files[*].output_xlsx`。
- terminal `files` 非空时一次调用 `send_files(paths=<terminal.files>)`，不要从 `data` 猜测或重建路径。
- 说明输出为每家公司一个 xlsx；每个文件保留对应公司合同 sheet 和 `补充协议附加件明细` sheet。
- 简要转述 `generated_count`、`skipped_manufacturer_count`。
- 如果 `warnings` 非空，必须转述给用户；常见情况是找不到厂家模板 sheet、同一厂家匹配多个 sheet、模板缺少日期/税率/明细表位置。
- 说明日期写运行当天，交货日期写运行当天 + 3 天，税率来自采购汇总表。
- 说明普通厂家明细表按 `产品名称=合同产品名称`、`单位=单位`、`数量=本次采购量`、`含税单价=原价`、`含税金额=总价` 填写；旧表的 `数量` 仍兼容，模板有 `规格型号` 列时才写入 `型号`。
- 说明厂家名包含 `正飞` 时使用采购汇总表同厂家跨明细加权 `均价` 填写 `含税单价`，并按 `均价 * 数量` 重算 `含税金额`。
- 说明主合同和 `补充协议附加件明细` 的 `合计` 行会同时汇总 `数量` 和 `含税金额`。
- 说明 `补充协议附加件明细` 从合同汇总模板的 `附加件明细模板` 复制并按同一厂家明细填写；附加件里的采购合同编号也不处理。
- `success=false`：只转述 `exception`；不要自动重新生成采购汇总表，除非用户明确要求。
