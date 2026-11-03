---
name: replenishment-algorithm-config-manage
description: 管理马帮 Amazon V1普通备货算法参数方案。用户要求查看备货公式参数、导出备货算法配置表给业务人员修改、校验配置表xlsx、导入/保存自定义参数方案、查看已有参数方案或准备用某套算法参数计算备货时使用。
type: replenishment
commands:
  - lxeskill replenish template
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 管理 Amazon V1 备货算法参数方案

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 本地输入或参数核验失败时说明实际错误与恢复所需输入；文件占用时提示关闭对应文件后重试。
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

- 新建或修改方案：先 `export` 导出配置表并通过 `send_files` 交付给用户编辑；用户传回后先运行 `validate-file`，通过后按用户意图 `import`（新建）或 `replace`（覆盖已有自定义方案）。
- 用 `list` / `show` 查看方案列表与详情，不硬编码方案名称。“默认”等系统内置方案不可覆盖或重命名。
- 用户仅管理参数时不自动触发备货计算；要求用某方案计算备货时，保留方案名并转入 `replenishment-workflow-map`。

## 规则与校验

- 配置表 XLSX 只是导入导出编辑介质，正式计算从 CLI 管理的方案库读取，不得直接手改内部 JSON。
- 方案管理销量权重、销量门槛、补货天数、运输方式、海运/同时空运拆分及特殊 MSKU 规则，不管理库存扣减（旧版配置表中的 `sea.min_weight_kg` 在导入时自动忽略）。
- 配置表黄色单元格为可编辑输入，灰色说明不参与导入；天数正整数、日销区间等约束以 `list-params` 和 `validate-file` 校验结果为准。校验失败时直接指出具体非法参数或结构错误。
