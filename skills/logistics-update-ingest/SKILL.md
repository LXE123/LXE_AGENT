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

- 不要调用外部项目的物流 ingest CLI。
- 不要现场拼接内联 Python。
- 不要直接调用物流 API；固定使用当前仓库的虚拟环境解释器和脚本。
- 不要自己解析混杂日志；只解析脚本返回的最后一行 JSON。

前置检查：

- 必填参数只有 `file_path`，缺失就先向用户追问，不执行。
- 输入文件建议符合命名规范：`公司名-线路-YYYY.MM.DD.xlsx`。
- `file_path` 可以是飞书下载得到的 agent 本机 Excel 路径；脚本会自动通过 HTTP 上传到物流 API。
- 如果用户直接提供物流 API 服务所在机器可访问的路径，也可以原样执行。
- 当前仓库通过 `LOGISTICS_API_BASE_URL` 连接物流 API；默认按配置开关连接远端 `http://192.168.1.142:8000`。

固定执行：

```json
{
  "tool": "exec",
  "args": {
    "command": "uv run --frozen python -X utf8 -m scripts.logistics_update_ingest --file-path \"{file_path}\""
  }
}
```

结果解读规则：

- 如果 `exec` 直接返回完成结果，读取返回 JSON 中的 `output`，并把它当作桥接脚本的唯一输出解析。
- 如果 `exec` 返回 `status=\"running\"`，用 `process(action=\"poll\", session=\"...\")` 等到结束；需要完整输出时再用 `process(action=\"log\", session=\"...\", offset=1)` 读取并解析完整 `output`。
- 只解析脚本输出的 JSON，不要从其它文本猜测状态。

脚本 JSON 协议：

- 成功：
  - `ok=true`
  - `file_path`
  - `job_id`
  - `status=succeeded`
  - `result`
- 仍在后台执行：
  - `ok=true`
  - `file_path`
  - `job_id`
  - `status=running`
  - `message`
- 失败：
  - `ok=false`
  - `file_path`
  - `job_id`（如果已经创建任务）
  - `status=failed`（如果服务端任务失败）
  - `error`
  - `error_type`（如果脚本本地异常）

业务结果处理：

- `ok=false`：只原样转述 `error`，不要自行补充原因。
- `ok=true` 且 `status=succeeded`：告诉用户物流报价导入完成，按需转述 `result.status`、`result.decision_reason` 和服务端原样返回字段。
- `ok=true` 且 `status=running`：告诉用户导入任务仍在后台执行，并保留 `job_id`，后续可用 `--job-id <job_id>` 查询。
- `result.status` 即使是 `rejected` 或 `ignored`，也表示脚本执行成功；不要把它当成脚本失败。
- 除非用户追问，否则不要自行解释 `decision_reason` 的业务含义。
