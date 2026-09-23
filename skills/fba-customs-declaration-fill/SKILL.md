---
name: fba-customs-declaration-fill
description: 用上传备货单的汇总表售价、ERP 只读计算的实发量和本地 WMS 箱重生成报关资料。用户要求填写报关单、报关资料、报关文件时使用；先展示各型号缺货预览，经用户确认后生成。
type: amazon_fba
commands:
  - lxeskill fba customs preview
  - lxeskill fba customs fill
---

# 报关资料填写

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 简单参数使用 flags；只把最后一条 `type="result"` 作为 terminal，先检查 `ok`，再读取 `data`、`files` 或真实 `error.message`。
- 备货单必须来自当前对话附件，使用附件下载后的真实绝对路径。不要修改附件或模板原件。
- 此流程只有只读计算与本地文件生成；禁止调用 ERP 正式对账确认命令。

## 输入与数据来源

- 一个或多个 `.xlsx` 备货单，文件名包含 SP 单号和目的国；多 SP 必须同一目的国。
- 表格需要「汇总表」和「备货单」。售价只取「汇总表」的「售价」，不取「备货单」中的售价或外部公式。
- SKU、走库存标记和必要的原价用于匹配价格来源；表格型号可以为空。表格数量、旧总价均不用于报关计算。
- ERP 提供计划量、MSKU 组成、SKU 实发量、厂家、型号、品名、单位、目的国及采购来源。每次预览自动重新下载马帮发货单 CSV，以 `MSKU发货量` 为本次实际数量。
- 本地 WMS 装箱资料只提供箱数、毛重；不会自动下载。缺少时按 CLI 返回的确切 SP 提示补齐，不用 WMS 数量代替 ERP 实发量。
- 若补充下载 WMS 装箱数据时返回空内容或空文件，保留实际错误，并询问用户：“<SP 单号> 的 WMS 装箱数据是否已从 ERP 中删除？”不要仅凭空响应断定数据已删除或接口故障。
- 多个候选行售价一致时采用共同售价，不要求唯一对应 Excel 某一行；售价不同时用 SKU、来源类型和必要的原价区分。仍无法确定售价及对应实发量时阻断，转述具体冲突行，不自行选价或跳过商品。
- 同一 SP、厂家、型号、品名、单位、售价和申报分类一致的明细合并，数量只累加一次；不同售价、不同申报分类或不同 SP 保留分行。合同、原价及新采购/走库存来源不同本身不阻止同价合并，来源与 Excel 候选行保留在诊断记录中。

## 长期资产

- `template_xlsx` 是系统记忆的 `customs_template`；平时不传，只有用户上传新版模板时传其真实路径。
- 缺少已存模板时按 `input_required` 索取；结果里的 `asset_sources.template_xlsx` 必须转述给用户。
- 附件用途不明确时询问用户，不把无法识别的备货单自动当作模板。

## 第一步：预览

```text
lxeskill fba customs preview --input-xlsx <附件路径>
```

多文件重复 `--input-xlsx`；上传新版模板时增加 `--template-xlsx <模板路径>`。单 SP 可通过 `--consignment-excel <装箱文件路径>` 指定重量资料。

- 展示 `model_summary` 的各 SP、厂家、型号、计划量、实发量、缺货量和多发量。缺货与多发分别展示，不能只报净差值。
- 明确列出 `excluded_lines` 中未纳入计算的商品。
- `status=blocked`：转述 `issues` 和诊断报告路径，解决后重新预览。
- `status=no_shipment`：说明本次无可申报实发商品，不生成空报关文件。
- `status=confirmation_required` 且 `can_generate=true`：让用户判断当前数量是否可用于报关。完全一致也展示，不推断“未装箱”，不要求先完成正式对账。
- 用户明确确认这次预览后才能进入第二步。保存返回的 `preview_path`，不要手动修改预览材料。

## 第二步：生成

```text
lxeskill fba customs fill --preview-path <上次预览返回的真实路径>
```

- 确认后使用固定的售价、CSV 和箱重资料；CLI 只读核验 ERP 计算依据。发生变化时重新预览并再次确认，不静默更新。
- 生成申报要素、报关单、发票、箱单、合同；零实发行不写入，最多 50 条有效价格行，多 SP 不合并价格行。
- 成功时提供 `output_xlsx`，确认 `quantity_basis=erp_preview`。只有正式报关文件属于交付附件，诊断报告不主动发送。
- terminal `files` 非空时，一次调用 `send_files(paths=<terminal.files>)` 发送正式报关文件。
- 检查 `unmatched_count` 和 `notice`，说明尚未匹配申报规则的商品；不要声称所有申报要素均已完整。
- 失败时保留真实错误；旧 `fill --input-xlsx` 必须改为先调用 `preview`。
