---
name: fba-logistics-rate-import
description: 导入物流报价或物流更新 Excel。用户要求导入物流报价表、运行物流更新脚本、ingest 物流 Excel、更新物流价格文件时使用。
type: amazon_fba
---

# Logistics Rate Import

## Hard Rules

- 只使用当前仓库脚本，不要调用外部项目 CLI。
- 不要现场拼接内联 Python，不要直接调用物流 API。
- 只解析脚本输出的 JSON，不要从混杂日志猜测状态。
- `result.status` 即使是 `rejected` 或 `ignored`，也表示脚本执行成功，不当作脚本失败。

## Required Input

- `file_path`: 物流报价 Excel 路径。
- 缺少 `file_path` 时先追问，不执行。
- 文件建议符合 `公司名-线路-YYYY.MM.DD.xlsx` 命名。
- 文件可以是飞书下载到 agent 本机的路径，也可以是物流 API 服务端可访问路径。

## Command

```json
{
  "tool": "exec",
  "args": {
    "command": "uv run --frozen python -X utf8 -m scripts.logistics_update_ingest --file-path \"{file_path}\""
  }
}
```

如果 `exec` 返回 `status="running"`，用 `process(action="poll", session="...")` 等待结束；需要完整输出时再读取日志。

## Result Handling

- `ok=false`：只原样转述 `error`。
- `ok=true` 且 `status=succeeded`：告诉用户物流报价导入完成，按需转述 `result.status` 和 `result.decision_reason`。
- `ok=true` 且 `status=running`：告诉用户导入任务仍在后台执行，并保留 `job_id`。
- 除非用户追问，否则不要自行解释 `decision_reason` 的业务含义。
