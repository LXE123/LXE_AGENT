---
name: mabang-order-import-generate
description: 根据巴西、马来西亚、越南、菲律宾或印尼备货 XLSX 生成马帮订单导入表。每种运输方式分别按最新日期及实际批次生成文件。适用于仅需生成本地导入文件的任务。
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

同一运输方式最新日期的同一批次存在重复列时，巴西或越南可先请用户从错误提示列出的候选列中选择，再将所选 Excel 列字母传给 `--shipping-column <Excel列字母>`，例如 `AT`。

菲律宾空运（无批次）、A 海运或 B 海运的最新日期同批次重复时，分别使用 `--air-shipping-column <Excel列字母>`、`--sea-a-shipping-column <Excel列字母>`、`--sea-b-shipping-column <Excel列字母>`；可同时传入多个参数。其他重复批次及马来西亚、印尼的重复列需要修正源表。

这些已有参数也可确认一列没有重复的最新日期列，但不能指定旧日期；菲律宾的按方式参数也不能指定其他批次。指定一列不会排除该日期的其他批次或其他运输方式。

## 国家规则

五国都使用用户提供的备货表和 lxeskillCLI 随包提供的马帮模板。所有国家均保留来源表中的全部非空 SKU 行、原顺序及重复项，不合并 SKU。订单编号和日期判断均以生成时的北京时间日期为基准；日期表头年份据此解释，颜色不影响选列。

| 国家 | 来源表与 SKU 列 | 订单前缀 |
|---|---|---|
| 巴西 | 「巴西」工作表，F 列为 SKU。 | `BR` |
| 马来西亚 | 「马来西亚」工作表，E 列为 SKU。 | `MY` |
| 越南 | 「越南备货清单」工作表，E 列为 SKU。 | `VN` |
| 菲律宾 | 「菲律宾备货清单」工作表，E 列为 SKU。 | `PH` |
| 印尼 | 「印尼」工作表，E 列为 SKU。 | `IN` |

五国均扫描第 1 行 `M/D` + 可选单个英文字母批次 + `陆运`、`空运` 或 `海运` 表头，巴西不限制在 AT:BD。对实际存在的每种运输方式分别选择最新日期，取该日期的全部批次；日期可以不同，也可以晚于生成日。可以只有一种运输方式，例如 `11/6陆运`、`11/6C空运`、`11/6B海运`。同一方式最新日期的同一批次重复或没有有效运输列时命令报错；重复列的处理见上文。

每个所选运输方式与批次生成一份。订单号是 `{国家前缀}{YYMMDD}[批次]-L`（陆运）、`-K`（空运）或 `-H`（海运），无批次时省略字母。例如 `IN261105C-H`；文件名为 `{国家名}马帮订单导入模板-{订单号}.xlsx`。

数量处理：五国都保留来源表中的非空 SKU 行；所选运输方式的数量为 0 或空值时，SKU 行保留且数量格留空。其他字段沿用模板默认值，商品单价为 `0`。SKU 及所选数量公式须有缓存结果，已计算得到空字符串时按空值处理；单元格错误、无缓存公式、非法数量或超出可保存精度的数值会使整单失败并报告实际单元格。

## 交付

检查终端 JSON 的 `ok`、`data.success`、`data.status`、`data.artifacts`、`data.sku_count` 和 `files`。只有生成成功并校验通过后，才交付 `files` 中的文件；文件数由各运输方式最新日期中实际存在的批次决定。同次生成的各份文件 SKU 行数应相同。成功时说明订单编号和所选运输日期；失败时转述实际诊断，不交付旧文件或不完整结果。
