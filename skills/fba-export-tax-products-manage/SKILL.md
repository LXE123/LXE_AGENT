---
name: fba-export-tax-products-manage
description: 维护出口退税产品白名单。用户要求把 SKU 加入出口退税产品列表、导入可出口退税 SKU、更新退税产品白名单时使用。
type: amazon_fba
commands:
  - lxeskill fba export-tax products-import
---

# Export Tax Products Manage

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 当前退税产品表必须来自当前对话附件；只使用附件下载结果中的真实绝对路径。禁止猜测路径、扫描系统目录或使用安装目录内的业务文件。
- 缺少退税产品表附件时停止执行并向用户索取文件，不要调用 CLI。
- CLI 不修改用户上传的原文件；有新增 SKU 时在受管 artifacts 中生成更新后的副本。
- 不要自己查询或拼接马帮 API 请求，不要手写或复用 bearer/freeToken/Cookie。
- v1 只支持导入新增 SKU，不支持删除、修改、查询。
- 已存在 SKU 不导入、不覆盖；马帮 API 查不到的 SKU 不导入。

## Required Input

- 至少一个 SKU，例如 `DX260430201`、`DX260428212`、`DX241122C06`。
- 用户上传的当前出口退税产品表 `.xlsx`。
- 没有 SKU 时先追问，不要启动 CLI。

## Command

```text
lxeskill fba export-tax products-import --sku <sku1> --sku <sku2> --products-path <uploaded_products_xlsx_path>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户 `imported_count`、`skipped_duplicate_count`、`skipped_not_found_count`。
- `backup_path` 非空：说明导入前已自动备份。
- `output_xlsx` 非空：terminal `files` 中会包含受管 artifacts 生成的更新后产品表，逐个调用 `send_file`；用户上传的原文件保持不变。
- `backup_path` 是诊断备份，不属于正式交付文件，不主动调用 `send_file`。
- `success=false`：只转述 `exception`。
