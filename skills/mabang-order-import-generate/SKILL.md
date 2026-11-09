---
name: mabang-order-import-generate
description: 根据巴西、马来西亚、越南、菲律宾或印尼备货 XLSX 生成马帮订单导入表。巴西、越南各一份，马来西亚、菲律宾各三份；印尼按各运输方式最新日期中的批次生成文件。适用于仅需生成本地导入文件的任务。
type: replenishment
commands:
  - lxeskill mabang order-import generate
---

# 马帮订单导入表生成

使用本轮提供的备货 `.xlsx` 文件和用户指定国家，通过统一命令生成订单导入文件。备货表的 SKU 表头为 `SKU`，SKU 内容为文本。马帮模板随 lxeskillCLI 提供，用户只需提供备货表。本 Skill 负责在本地生成文件，马帮系统中的实际导入由用户完成。

## 调用

确认用户指定的国家后，使用附件保存后的真实绝对路径调用命令。国家尚未指定时，先确认目标国家：

```bash
lxeskill mabang order-import generate --country malaysia --input-xlsx "/实际路径/马来西亚备货清单.xlsx"
lxeskill mabang order-import generate --country brazil --input-xlsx "/实际路径/巴西备货清单.xlsx"
lxeskill mabang order-import generate --country vietnam --input-xlsx "/实际路径/越南备货清单.xlsx"
lxeskill mabang order-import generate --country philippines --input-xlsx "/实际路径/菲律宾备货清单.xlsx"
lxeskill mabang order-import generate --country indonesia --input-xlsx "/实际路径/印尼备货清单.xlsx"
```

巴西或越南最近日期并列时，先请用户从错误提示列出的候选列中选择，再将所选 Excel 列字母传给 `--shipping-column <Excel列字母>`，例如 `AT`。

菲律宾某种运输方式的最近日期并列时，先请用户从错误提示列出的候选列中选择。空运、A 海运、B 海运分别使用 `--air-shipping-column <Excel列字母>`、`--sea-a-shipping-column <Excel列字母>`、`--sea-b-shipping-column <Excel列字母>`，例如 `AO`；多种运输方式并列时，可同时传入对应的选列参数。

## 国家规则

五国都使用用户提供的备货表和 lxeskillCLI 随包提供的马帮模板。所有国家均保留来源表中的全部非空 SKU 行、原顺序及重复项，不合并 SKU。订单编号和日期判断均以生成时的北京时间日期为基准；日期表头年份据此解释，颜色不影响选列。

| 国家 | 来源表与 SKU 列 | 日期选择 | 输出 |
|---|---|---|---|
| 巴西 | 「巴西」工作表，F 列为 SKU。 | AT:BD 每列的第 1 行需为 `月/日[可选字母]海运` 表头；从这些列选择离生成时北京时间日期最近的一列，过去和未来日期都参与；并列时请用户选择候选列。 | 一份订单导入表，编号 `BR{YYMMDD}-H`，文件名 `巴西马帮订单导入模板-{订单号}.xlsx`。 |
| 马来西亚 | 「马来西亚」工作表，E 列为 SKU。 | 按生成时北京时间日期解释表头年份，再选择日期最新组中的空运、A 海运、B 海运列；该组缺少任一列时停止。 | 三份表：A 海运 `MY{YYMMDD}A-H`、B 海运 `MY{YYMMDD}B-H`、空运 `MY{YYMMDD}-K`；文件名 `马来西亚马帮订单导入模板-{订单号}.xlsx`。 |
| 越南 | 「越南备货清单」工作表，E 列为 SKU。 | 从 `M/D陆运`、`M/D海运` 列中选择离生成时北京时间日期最近的一列，过去和未来日期都参与；并列时请用户选择候选列。 | 一份订单导入表：陆运编号 `VN{YYMMDD}-L`，海运编号 `VN{YYMMDD}-H`；文件名 `越南马帮订单导入模板-{订单号}.xlsx`。 |
| 菲律宾 | 「菲律宾备货清单」工作表，E1 为 `SKU`，E 列 SKU 为文本。 | 空运、A 海运、B 海运分别从 `M/D空运`、`M/DA海运`、`M/DB海运` 列中选择离生成时北京时间日期最近的一列，过去和未来日期都参与；并列时请用户选择候选列。 | 三份表：空运 `PH{YYMMDD}-K`、A 海运 `PH{YYMMDD}A-H`、B 海运 `PH{YYMMDD}B-H`；文件名 `菲律宾马帮订单导入模板-{订单号}.xlsx`。 |
| 印尼 | 「印尼」工作表，E1 为 `SKU`（不区分大小写），E 列 SKU 为文本。 | 扫描第 1 行 `M/D` + 可选单个英文字母批次 + `陆运`、`空运` 或 `海运` 表头。对实际存在的每种运输方式分别选择最新日期，取该日期的全部批次；日期可以不同，也可以晚于生成日。 | 每个所选运输方式与批次生成一份。编号为 `IN{YYMMDD}[批次]-L`（陆运）、`IN{YYMMDD}[批次]-K`（空运）或 `IN{YYMMDD}[批次]-H`（海运），无批次时省略批次字母；文件名 `印尼马帮订单导入模板-{订单号}.xlsx`。 |

印尼备货表可以只有一种运输方式，也可以包含陆运、空运、海运的任意组合。每种方式可无批次或使用任意单个英文字母批次，例如 `11/6陆运`、`11/6C空运`、`11/6B海运`。同一运输方式的最新日期中，同一批次（含无批次）有重复列时，命令报错并要求修正源表；没有有效运输列时也会报错。

数量处理：五国都保留来源表中的非空 SKU 行；所选运输方式的数量为 0 或空值时，SKU 行保留且数量格留空。其他字段沿用模板默认值，商品单价为 `0`。SKU 及所选数量公式须有缓存结果，已计算得到空字符串时按空值处理；单元格错误、无缓存公式、非法数量或超出可保存精度的数值会使整单失败并报告实际单元格。

## 交付

检查终端 JSON 的 `ok`、`data.success`、`data.status`、`data.artifacts`、`data.sku_count` 和 `files`。只有生成成功并校验通过后，才交付 `files` 中的文件；马来西亚和菲律宾各应有三个文件，印尼文件数由各运输方式最新日期中实际存在的批次决定。同次生成的各份文件 SKU 行数应相同。成功时说明订单编号和所选运输日期；失败时转述实际诊断，不交付旧文件或不完整结果。
