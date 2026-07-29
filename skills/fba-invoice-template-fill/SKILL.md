---
name: fba-invoice-template-fill
description: 根据用户上传的备货 xlsx、本地 FBA 发货单 CSV 和本地 WMS 装箱数据填写发票导入模板，按 WMS 实际发货量生成 invoice_Template 和数量校验报告。用户要求填写发票模板、生成发票导入表、把备货单写入 invoice_Template，或为 FBA 发票资料准备模板时使用。
type: amazon_fba
commands:
  - lxeskill fba invoice fill
---

# Invoice Template Fill

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要手动编辑用户备货单或发票模板。
- 备货单和发票模板都必须来自当前对话附件；只使用附件下载结果中的真实绝对路径。禁止猜测路径、扫描系统目录或使用安装目录内的模板。
- 任一必需附件缺失时停止执行并向用户索取文件，不要调用 CLI。
- 不要自己拼接马帮 API 请求，不要手写或复用 Cookie/token。
- 只使用本地已有 FBA 发货单 CSV 和 WMS 装箱数据；缺文件时转述 CLI 失败原因，不自动补下载。
- WMS `装箱数量` 是发票模板的实际发货量来源；发货单 CSV 只提供 `MSKU -> 库存 SKU` 组成关系。
- 备货单第一个表格提供 `库存 SKU -> 规则型号` 映射；汇总表 `SKU` 作为型号组代表行。
- 发票明细按 `箱号 + 汇总表代表 SKU` 写入；实际发货量为 0 的代表行不写入模板。
- 产品图片来自库存 SKU Excel 的 `库存sku图片`。
- 不按汇总表预期 `发货量` 填写正式数量。
- 材质、用途、申报价规则无法匹配时，CLI 会在 `notice` 中提示。

## Required Input

- 一个备货 `.xlsx` 文件。
- 文件名必须包含 `SP...` 单号和目的国。
- 本地必须已存在对应的 FBA 发货单 CSV：`artifacts/fba/delivery_csv/<SP单号>_*.csv`。
- 本地必须已存在对应的 WMS 装箱数据 Excel。
- 缺少文件时先追问，不要启动 CLI。

## 长期资产（自动记忆）

- `template_xlsx`（发票模板）是**长期资产**：系统记住当前版，**平时不要传这个参数**。
- 只有用户在本轮对话里上传了新版本时才传它的绝对路径；CLI 会自动把它升为当前版，旧版留一份可回退。
- 用户没上传、系统也没存过时，CLI 会返回 `input_required`，这时才向用户索取。
- 结果里的 `asset_sources.template_xlsx` 必须转述给用户，例如「使用发票模板：xxx.xlsx（07-06 上传）」，让用户能发现用错了版本。

## 上传分流

同一条消息里的 `.xlsx` 附件要分清用途，**不要猜**：

- 文件名含 `SP` 单号（如 `6.2-SP260601002-新棱镜备货-美国.xlsx`）→ 本次备货单，传给 `input_xlsx`。
- 文件名不含 `SP` 单号 → 发票模板，传给 `template_xlsx`。
- 判断不了就直接问用户，不要试。

## Command

```text
lxeskill fba invoice fill --input-xlsx <备货单.xlsx>
```

用户上传了新版本时（只有这种情况才传该参数）：

```text
lxeskill fba invoice fill --input-xlsx <备货单.xlsx> --template-xlsx <新版发票模板.xlsx>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户发票模板已生成，并提供 `output_xlsx`。
- terminal `files` 中只有正式发票；非空时一次调用 `send_files(paths=<terminal.files>)`。校验报告和库存 SKU 中间文件不主动发送。
- 确认 `quantity_basis=actual`。
- 如果有 `validation_report_xlsx`，告诉用户数量校验报告也已生成，包含 `数量校验`、`汇总表计算前后对比`、`数据来源`。
- 可简要转述 `invoice_row_count`、`box_count`、`image_missing_count`。
- `notice` 非空：简要转述缺图或缺少申报价规则的提示。
- `success=false`：只转述 `exception`。
