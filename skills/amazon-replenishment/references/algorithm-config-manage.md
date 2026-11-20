# 管理 Amazon V1 备货算法参数方案

用户要求查看 V1 备货公式参数、导出配置表给业务人员修改、校验配置表 XLSX、导入/保存自定义参数方案，或指定某套参数方案计算 V1 备货时使用：

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

## 流程与规则

- 新建或修改方案：先 `export` 导出配置表并通过 `send_files(paths=<terminal.files>)` 交付给用户编辑；用户传回后先运行 `validate-file`，通过后按用户意图 `import`（新建）或 `replace`（覆盖已有自定义方案）。
- 用 `list` / `show` 查看方案列表与详情，不硬编码方案名称。“默认”等系统内置方案不可覆盖或重命名。
- 用户仅管理参数时不自动触发备货计算；要求用某方案计算 V1 备货时，保留方案名并传给 `lxeskill replenish calculate --version v1 ... --template "<方案名>"`。
- 配置表 XLSX 只是导入导出编辑介质，正式计算从 CLI 管理的方案库读取，不得直接手改内部 JSON。
- 方案管理销量权重、销量门槛、补货天数、运输方式、海运/同时空运拆分及特殊 MSKU 规则，不管理库存扣减（旧版配置表中的 `sea.min_weight_kg` 在导入时自动忽略）。
- 配置表黄色单元格为可编辑输入，灰色说明不参与导入；天数正整数、日销区间等约束以 `list-params` 和 `validate-file` 校验结果为准。校验失败时直接指出具体非法参数或结构错误。
