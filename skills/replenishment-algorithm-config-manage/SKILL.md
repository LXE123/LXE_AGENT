---
name: replenishment-algorithm-config-manage
description: 管理马帮 Amazon V1普通备货算法参数方案。用户要求查看备货公式参数、导出备货算法配置表给业务人员修改、校验配置表xlsx、导入/保存自定义参数方案、查看已有参数方案或准备用某套算法参数计算备货时使用。
type: replenishment
commands:
  - lxeskill replenish template
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 管理 Amazon V1备货算法参数方案

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 本地输入、来源或参数核验失败时说明实际错误与恢复所需输入；文件占用时提示关闭对应文件后重试。
- 完整备货由 `replenishment-workflow-map` 继续。独立单步只执行本步骤；有附件时使用 `send_files(paths=<terminal.files>)` 交付，发送失败只重试交付。

## 命令与流程

```text
lxeskill replenish template list
lxeskill replenish template list-params
lxeskill replenish template show --template "<方案名>"
lxeskill replenish template export --template "<方案名>"
lxeskill replenish template validate-file --xlsx "<用户修改的配置表>"
lxeskill replenish template import --xlsx "<配置表>" [--name "<新方案名>"]
lxeskill replenish template replace --template "<已有自定义方案名>" --xlsx "<配置表>"
lxeskill replenish template rename --template "<旧名称>" --name "<新名称>"
```

- 新建/修改方案：导出供用户编辑，用户返回后先 validate-file，通过后按其意图 import 或 replace。发送导出 terminal files，不把内部方案库当附件。
- 用 list/show 判断方案是否存在及系统方案限制，不硬编码全部方案名称。“默认”和其他系统方案不能覆盖或重命名。
- 用户只要求查看/管理参数时不自动计算；要求用该方案完成备货时保留方案名并交给完整流程。

## 规则与错误

- 配置表只是编辑介质，正式计算读取方案库。不得手改 JSON；只通过 CLI 管理。
- 方案管理权重、销量门槛、天数、运输方式、海运/同时空运拆分及特殊 MSKU 规则，不管理库存扣减。
- 海运重量门槛已取消，缺重量不阻断海运；旧 `sea.min_weight_kg` 忽略，仅含旧重量字段的兼容配置仍允许导入。
- 校验失败保留实际错误。只有错误明确说明结构不兼容才重新导出；参数值非法就指出具体参数，不套用“旧版不支持”的固定话术。
- 黄色单元格是可编辑输入，灰色说明不参与导入；天数正整数、日销区间等规则以 list-params 和校验结果为准。
