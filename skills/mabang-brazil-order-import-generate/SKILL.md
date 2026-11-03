---
name: mabang-brazil-order-import-generate
description: 根据巴西备货清单生成马帮订单导入模板。用户要求把巴西备货清单整理成马帮订单导入文件、生成马帮订单模板或导出订单导入表时使用。
type: replenishment
commands:
  - lxeskill mabang brazil order-import generate
---

# 巴西马帮订单导入模板

## 输入与处理

- 需要用户提供本轮的巴西备货清单 `.xlsx` 附件，调用时使用附件保存后的真实绝对路径；缺少文件时请用户上传。
- 依赖现有 `lxeskill` 命令和随包的马帮订单模板。备货清单需包含 `巴西` 工作表，F1 为 `sku`，AT:BD 第 1 行为海运日期表头，格式为 `月/日[可选字母]海运`。
- SKU 或所选数量列含公式时，需要文件中已有保存的计算结果；命令会指出缺少结果的单元格，请用户在表格软件中重新计算并保存后再提供文件。真正空白的数量仍保留为空白。
- 海运日期表头只有月/日时，命令按当前中国日期最近的年份解释。
- 比较 AT:BD 全部海运日期，选择距离当前中国日期最近的一列；过去和将来的日期都参与比较，表头颜色不影响选择。若最近日期并列，询问用户选择其中一列，再把选择作为 `--shipping-column` 传入。

## 执行

通过 `exec` 调用现有 lxeskill 命令：

```text
lxeskill mabang brazil order-import generate --input-xlsx <附件的绝对路径>
```

只有最近日期并列且用户已选择列时，才追加 `--shipping-column <列名>`。模板填充和校验由命令完成。

## 交付

- 等待本次命令的最终 `type="result"` 记录，根据 `ok` 判断结果。
- `ok=true` 时交付 `files` 中的生成文件，并说明订单编号、SKU 数量及所选海运日期；`data.validation.status` 应为 `passed`。
- `ok=false` 时根据实际错误说明失败原因。
- 该流程只生成本地马帮导入模板，不登录马帮、不提交订单。
