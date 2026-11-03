---
name: mabang-brazil-order-import-generate
description: 根据巴西备货清单生成马帮订单导入模板。用户要求把巴西备货清单整理成马帮订单导入文件、生成马帮订单模板或导出订单导入表时使用。
type: replenishment
commands:
  - lxeskill mabang brazil order-import generate
---

# 巴西马帮订单导入模板

## 输入与处理

- 需要用户提供本轮的巴西备货清单 `.xlsx` 附件；使用附件保存后的真实绝对路径，不猜测或复用其他任务的文件。
- 备货清单的 `巴西` 工作表和模板字段由命令处理。海运日期表头只有月/日时，命令按当前中国日期最近的年份解释。
- 日期选择优先看 AT:BD 海运表头中标黄的字段：有标黄列时，只在标黄列中选择离当前中国日期最近的日期；若最近日期并列，询问用户选择其中一列，再把选择作为 `--shipping-column` 传入。
- 没有标黄海运表头时，才在全部日期列中选择最近日期；若并列，同样询问用户后传入选择。不要只根据列顺序或表头文字猜测标黄。
- 用户没有上传文件时，先请用户上传文件，不调用命令。

## 执行

通过 `exec` 调用现有 lxeskill 命令：

```text
lxeskill mabang brazil order-import generate --input-xlsx <附件的绝对路径>
```

只有优先候选日期并列且用户已选择列时，才追加 `--shipping-column <列名>`。命令处理模板填充和校验；不要另写表格处理脚本，也不要直接调用内部 Python 模块。

## 交付

- 等待本次命令的最终 `type="result"` 记录，根据 `ok` 判断结果。
- `ok=true` 时交付 `files` 中的生成文件，并说明订单编号、SKU 数量及所选海运日期；`data.validation.status` 应为 `passed`。
- `ok=false` 时根据实际错误说明失败原因，不重复启动命令来掩盖错误。
- 该流程只生成本地马帮导入模板，不登录马帮、不提交订单。
