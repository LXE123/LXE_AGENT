---
name: fba-logistics-rate-import
description: 导入物流报价或物流更新 Excel。用户要求导入物流报价表、运行物流更新脚本、ingest 物流 Excel、更新物流价格文件时使用。
type: amazon_fba
commands:
  - lxeskill fba logistics rates-import
---

# Logistics Rate Import

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行 Python 模块或物流 API。
- 只解析 stdout 中的 lxeskill JSONL；诊断日志只会出现在 stderr。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message`。
- `result.status` 即使是 `rejected` 或 `ignored`，也表示脚本执行成功，不当作脚本失败。

## Required Input

- `file_path`: 物流报价 Excel 路径。
- 缺少 `file_path` 时先追问，不执行。
- 文件建议符合 `公司名-线路-YYYY.MM.DD.xlsx` 命名。
- 文件可以是飞书下载到 agent 本机的路径，也可以是物流 API 服务端可访问路径。

## Command

```bash
lxeskill fba logistics rates-import --file-path "{file_path}"
```

如果 `exec` 返回 `status="running"`，用 `process(action="poll", session="...")` 等待结束；需要完整输出时再读取日志。

## Result Handling

- `ok=false`：只原样转述 `error`。
- `ok=true` 且 `status=succeeded`：告诉用户物流报价导入完成，按需转述 `result.status` 和 `result.decision_reason`。
- `ok=true` 且 `status=running`：告诉用户导入任务仍在后台执行，并保留 `job_id`。
- 除非用户追问，否则不要自行解释 `decision_reason` 的业务含义。
