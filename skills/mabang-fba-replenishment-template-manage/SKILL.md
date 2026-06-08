---
name: mabang-fba-replenishment-template-manage
description: 管理马帮 Amazon 备货参数模板。用户要求查看备货公式参数、导出模板给业务人员修改、校验模板xlsx、导入/保存自定义备货模板、查看已有模板或准备用某套算法参数计算备货时使用。
type: amazon_replenish
---

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.replenishment_template ...`
- 不要手改正式模板库 JSON；必须通过 CLI 导入。
- xlsx 只是人工编辑介质，正式计算读取模板库。
- `默认模板` 是系统模板，不允许覆盖、删除或替换。
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
- 用户要改模板名：运行 `rename`，不要用“导入新名”模拟改名。
- 用户没有提供模板名：导入时不传 `--name`，系统自动生成 `自定义模板1`、`自定义模板2`。
- 用户要用某模板计算备货：切换到 `mabang-fba-store-replenishment-calculate`，运行备货计算 CLI 并传 `--template "<模板名>"`。

## Result Handling

- 所有 CLI 都只读取最后一行 JSON。
- `success=true`：转述模板名、版本、`xlsx_path` 或 warnings。
- `success=false`：只转述 `exception`，不要猜测模板内容。
