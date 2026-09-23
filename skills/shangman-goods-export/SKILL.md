---
name: shangman-goods-export
description: 为东南亚备货采集上马 ERP（Shangman ERP）商品、库存及销量原始数据，也用于独立下载上马报表。复用上马登录态，产出一份平台原始 XLSX；只负责采集与校验，不执行备货计算。不用于马帮 TMS（旧称智汇 TMS）、雅仓或马帮 ERP。
type: replenishment
commands:
  - lxeskill shangman export run
---

# 上马商品导出

## 范围

- 本 Skill 是 `southeast-asia-replenishment-workflow-map` 的数据采集步骤，也支持独立导出。流程调用成功后将本次结果交回调用入口，不自行开始后续整理或计算。
- 用户明确要求上马商品、库存或销量导出时，执行上马 ERP 当前配置账号可见的商品全量导出。
- 库存和销量共用同一份商品原始报表，不分别生成文件。销量字段为 7、15、30 天累计量；只解释文件实际提供的字段，不承诺逐日明细、历史库存、独立入库／上架报表或补货建议。
- 用户明确指定日期、仓库或本接口不支持的数据范围时，先说明只能导出全量原始表并确认是否接受，不静默忽略筛选要求。

## 执行与登录衔接

通过 `exec` 调用唯一命令，不拼接口、不执行内部 Python 模块、不传账号、Token 或下载地址：

```text
lxeskill shangman export run
```

- 无需先查登录状态或额外预览。脚本读取已保存的登录态；命令仍在运行时等待同一执行，不重复启动。
- 返回 `data.error.code=login_required` 时，读取并使用 `shangman-login` Skill。遵守现有验证码识读、用户纠正和失败重试规则；只有登录成功且已保存，才返回本 Skill 继续原导出任务。
- 同一导出任务最多自动衔接一次登录。恢复后仍需登录时报告真实错误并停止，不形成登录／导出循环。
- 缺少桌面配置时说明实际缺项。权限拒绝、限流、网络错误、导出结果不确定等错误均保留实际诊断，不自动重复提交。

## 校验与交付

- 只认最后一条 `type="result"`，先看顶层 `ok`，再读取 `data` 和 terminal `files`。
- 成功时保留 `data.artifact_path`、`data.sheet_names`、`data.row_count` 及 terminal `files`。独立导出且 `files` 包含真实文件时，一次调用 `send_files(paths=<terminal.files>)`；流程调用时将这些结果返回调用入口，由入口统一安排交付，不在两处重复发送。只交付这一份平台原始 XLSX，不修改内容、补列或生成新报表。
- 文件名为 `上马-商品-YYYYMMDD-HHMMSS.xlsx`；报告文件名和 `row_count`，零行时明确说明没有商品数据。
- 文件生成与附件交付分开说明，发送成功才称已交付。发送失败只重试文件交付，不重新执行导出。
- 失败转述 `data.error` 与顶层 `error.message` 的实际脱敏诊断，不猜失败原因，不读取或展示本地 Token。
