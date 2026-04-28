---
name: logistics-update-ingest
description: 物流更新 Excel 导入指南。用户要求导入物流报价表、运行物流更新脚本、ingest 物流 Excel、更新物流价格文件时，使用这个 skill。
type: default
---

## When to Use

- 用户要导入物流更新 Excel。
- 用户提到“物流更新”、“物流报价表”、“导入物流 Excel”、“ingest 物流文件”、“更新物流脚本”。
- 用户已经提供本地 Excel 文件路径，或当前任务就是先确认该路径。

## How to Execute

先记住这些硬约束：

- 不要调用外部项目的 CLI：`python -m logistics_ingest.cli.ingest_file`。
- 不要现场拼接内联 Python。
- 不要自己解析混杂日志；只解析桥接脚本返回的 JSON。
- 固定使用当前仓库的虚拟环境解释器和桥接脚本。

前置检查：

- 必填参数只有 `file_path`，缺失就先向用户追问，不执行。
- 输入文件建议符合命名规范：`公司名-线路-YYYY.MM.DD.xlsx`。
- 外部物流项目 `D:\rpa\PRD\amazon\20260212 - AMAZON_logistic\logistics_excel` 需要能从它自己的 `.env` / `.env.local` / `.env.example` 读取 `PG_DSN`。

固定执行：

```json
{
  "tool": "exec",
  "args": {
    "command": "uv run --frozen python -X utf8 .\\scripts\\logistics_update_ingest.py --file-path \"{file_path}\""
  }
}
```

结果解读规则：

- 如果 `exec` 直接返回完成结果，读取返回 JSON 中的 `output`，并把它当作桥接脚本的唯一输出解析。
- 如果 `exec` 返回 `status=\"running\"`，用 `process(action=\"poll\", session=\"...\")` 等到结束；需要完整输出时再用 `process(action=\"log\", session=\"...\", offset=1)` 读取并解析完整 `output`。
- 只解析桥接脚本输出的 JSON，不要从其它文本猜测状态。

桥接 JSON 协议：

- 成功：
  - `ok=true`
  - `file_path`
  - `result`
- 失败：
  - `ok=false`
  - `file_path`
  - `error`
  - `error_type`

业务结果处理：

- `ok=false`：只原样转述 `error`，不要自行补充原因。
- `ok=true`：读取 `result.status`、`result.decision_reason` 和外部服务原样返回的字段。
- `result.status` 即使是 `rejected` 或 `ignored`，也表示桥接脚本执行成功；不要把它当成脚本失败。
- 除非用户追问，否则不要自行解释 `decision_reason` 的业务含义。
