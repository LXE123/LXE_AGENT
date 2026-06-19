---
name: replenishment-template-manage
description: 管理马帮 Amazon 备货参数模板。用户要求查看备货公式参数、导出模板给业务人员修改、校验模板xlsx、导入/保存自定义备货模板、查看已有模板或准备用某套算法参数计算备货时使用。
type: amazon_replenish
---

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.replenishment_template ...`
- 不要手改正式模板库 JSON；必须通过 CLI 导入。
- xlsx 只是人工编辑介质，正式计算读取模板库。
- 模板只管理论算法参数：日销计算、补货天数、空运判断、海运进入条件、海运补货天数、海运同时空运、特殊 MSKU 规则。
- 模板不管理库存扣减；`FBA 总库存（马帮数据）`、未关联货件、亚马逊补充库存扣减由备货计算 CLI 固定处理。
- xlsx 中浅黄色单元格表示业务可修改，会影响导入后的算法参数。
- xlsx 中浅灰色单元格是参数名或说明信息，不作为算法输入。
- 每个 sheet 的表格下方有 `修改说明` 区，说明区不参与导入。
- `补货天数`、`海运补货天数`、`海运同时空运` 使用 `日销范围` 作为权威输入。
- `海运补货天数` 和 `同时空运天数` 只能填写一个正整数，不支持 `100,110` 这种多值写法。
- 旧版模板 xlsx 不兼容；用户要修改模板时必须重新 `export` 新版模板后再编辑。
- `默认模板` 是系统模板，不允许覆盖、删除或替换。
- `US模板-一组`、`UK模板-一组`、`DE模板-一组` 也是系统模板，不允许覆盖、删除、替换或重命名。
- 海运开关是必填参数；旧模板缺少 `sea.enabled` 时需要重新导出模板并导入。
- 自定义模板保存在 `artifacts/mabang_replenishment_templates/templates.json`，不进入 git。
- 用户编辑 xlsx 保存在 `artifacts/mabang_replenishment_templates/editable/`，不进入 git。

## Commands

查看已有模板：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template list
```

查看可修改参数：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template list-params
```

导出给用户修改的 xlsx：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template export --template "<模板名>"
```

校验用户改回来的 xlsx：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template validate-file --xlsx "<模板文件>"
```

导入为正式自定义模板：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template import --xlsx "<模板文件>" [--name "<模板名>"]
```

替换已有自定义模板参数：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template replace --template "<已有模板名>" --xlsx "<模板文件>"
```

重命名已有自定义模板：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template rename --template "<旧模板名>" --name "<新模板名>"
```

查看模板详情：

```powershell
uv run --frozen python -m services.agent_cli.mabang.replenishment_template show --template "<模板名>"
```

## Workflow

- 用户问“能改哪些参数”：运行 `list-params`。
- 用户要新建模板：先 `export`，把 `xlsx_path` 给用户修改；用户发回后先 `validate-file`，通过后 `import`。
- 用户要修改已有模板：先 `export`，把 `xlsx_path` 给用户修改；用户发回后先 `validate-file`，通过后 `replace`。
- 给用户说明：优先改浅黄色单元格；表格下方的灰色 `修改说明` 用来辅助理解，不会作为算法参数导入。
- 用户要改模板名：运行 `rename`。
- 用户没有提供模板名：导入时不传 `--name`，系统自动生成 `自定义模板1`、`自定义模板2`。
- 用户要用某模板计算备货：切换到 `replenishment-calculate`，运行备货计算 CLI 并传 `--template "<模板名>"`。
- 内置模板可直接用于计算：`默认模板`、`US模板-一组`、`UK模板-一组`、`DE模板-一组`。
- `海运进入条件` sheet 中 `是否启用海运=否` 时，超过空运阈值的 MSKU 不计算海运，进入 `暂不建议发货`。
- 如果用户发来旧版模板 xlsx，校验失败时转述“旧版模板xlsx不再支持，请重新导出新版模板后修改”，然后重新执行 `export`。

## Result Handling

- 所有 CLI 都只读取最后一行 JSON。
- `success=true`：转述模板名、版本、`xlsx_path` 或 warnings。
- `success=false`：只转述 `exception`，不要猜测模板内容。
