---
name: mabang-order-import-generate
description: 根据巴西、马来西亚或越南备货 XLSX 生成马帮订单导入表。巴西、越南各生成一份，马来西亚按最新日期组生成 A 海运、B 海运、空运三份；适用于仅需生成本地导入文件的任务。
type: replenishment
commands:
  - lxeskill mabang order-import generate
---

# 马帮订单导入表生成

使用本轮提供的备货 `.xlsx` 文件和用户指定国家，通过统一命令生成订单导入文件。工作簿只在本地生成，不登录马帮或提交订单。

## 调用

国家明确后，使用附件保存后的真实绝对路径：

```bash
lxeskill mabang order-import generate --country malaysia --input-xlsx "/实际路径/马来西亚备货清单.xlsx"
lxeskill mabang order-import generate --country brazil --input-xlsx "/实际路径/巴西备货清单.xlsx"
lxeskill mabang order-import generate --country vietnam --input-xlsx "/实际路径/越南备货清单.xlsx"
```

仅当巴西或越南最近日期并列、用户已选定列时，额外传 `--shipping-column <列名>`。国家不明确时先询问；不要只凭文件名决定国家。

## 国家规则

| 国家 | 来源与选择 | 输出 |
|---|---|---|
| 巴西 | 「巴西」工作表，按距中国当天最近的海运日期选列；过去和将来的日期均参与，表头颜色不影响选择，等距时先询问。 | 一份订单导入表，编号 `BR{YYMMDD}-H`，文件名 `巴西马帮订单导入模板-{订单号}.xlsx` |
| 马来西亚 | 「马来西亚」工作表，E 列为 SKU；选择最新日期组中的空运、A 海运、B 海运列。 | 三份表：A 海运 `MY{YYMMDD}A-H`、B 海运 `MY{YYMMDD}B-H`、空运 `MY{YYMMDD}-K`；文件名 `马来西亚马帮订单导入模板-{订单号}.xlsx` |
| 越南 | 「越南备货清单」工作表，E 列为 SKU；在 `M/D陆运`、`M/D海运` 日期列中按距中国当天最近选择一列，过去和未来日期都参与、忽略颜色，等距时先询问。 | 一份订单导入表；陆运编号 `VN{YYMMDD}-L`，海运编号 `VN{YYMMDD}-H`，文件名 `越南马帮订单导入模板-{订单号}.xlsx` |

订单号日期取生成当天的中国日期。马来西亚、越南均保留全部非空 SKU 行、原顺序和重复行；数量须为有限非负数，为空或为 0 时，T 列留空。源 SKU 与所选数量公式须有缓存结果，无缓存公式或非法数量时整单失败并报告实际单元格。其他默认值和格式沿用共享模板，商品单价为 `0`。

## 交付

检查终端 JSON 的 `ok`、`data.success`、`data.status`、`data.artifacts`、`data.sku_count` 和 `files`。只有生成成功并校验通过后，才交付 `files` 中的文件；马来西亚应有三个文件，且三份的 SKU 行数相同。成功时说明订单编号和所选运输日期；失败时转述实际诊断，不交付旧文件或不完整结果。
