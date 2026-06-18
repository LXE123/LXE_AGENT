---
name: fba-shipment-create
description: 用固定 CLI 完成 Amazon FBA 创建货件流程。用户要求创建货件、上传装箱数据、生成多包装箱 Excel、确认自己的承运人、输入追踪号，或继续 prepare_upload / prepare_multi_box_excel / confirm_own_carrier / enter_tracking_codes 任一阶段时使用。
type: amazon_fba
---

# FBA Shipment Create

## Hard Rules

- 只执行下方四段固定 CLI；不要手动操作 Seller Central 页面。
- 执行前必须通过 `ziniao_browser.get_status` 获取真实 `store_id`。
- 店铺已打开时不要 `open_store`；重启店铺表示流程要从第一段重来。
- 任一阶段失败时停止，只转述 CLI JSON 的 `exception` 和必要 `context`。
- 失败后不要刷新、截图诊断、重跑阶段、重启店铺或跨阶段补救，除非用户明确要求。
- 唯一自动回退例外：第三阶段 `notice == "亚马逊店铺页面店铺出现bug，已返回第二步开头，请执行第二阶段CLI"` 时，直接执行第二阶段。
- 后台命令仍在运行时只等待或读取该 session 结果，不重复启动同一阶段。

## Required Input

必须明确：

- `store_id`: 只接受 `ziniao_browser.get_status` 返回值。
- `site`: `US`、`UK`、`DE`、`FR`、`IT`、`ES`、`CA`、`JP`、`AU` 等标准站点代码。
- `consignment_no`: 托运单号。
- `transport_mode`: 运输方式业务输入，后续 CLI 会原样回传。

店铺名解析规则：

- 不要把紫鸟店铺名里的 `-US`、`-CA`、`-UK` 后缀当成业务站点约束。
- 用户给基础店铺名和站点时，先找完整店铺名；找不到再按去除站点后缀后的基础店铺名唯一匹配。
- `context.site` 仍写用户指定站点，由 CLI 进入店铺后切换站点。

## Context File

执行 CLI 前，用 `write` 工具创建 `artifacts/amazon_fba/context_<consignment_no>.json`；不要把 JSON 直接塞进命令行参数。

```json
{
  "store_id": "<store_id>",
  "site": "<site>",
  "consignment_no": "<consignment_no>",
  "transport_mode": "<transport_mode>"
}
```

## Stage Table

| Stage | 前置条件 | Command | 成功标志 | 附件行为 | 下一步 |
|---|---|---|---|---|---|
| 1 `prepare_upload` | context 已写好 | `uv run --frozen python -m services.agent_cli.browser.amazon_fba.prepare_upload --context-file "artifacts/amazon_fba/context_<consignment_no>.json"` | `finished=true` 且 notice 提示第一阶段完成 | 发送 `file_path` 中的附件 | 第二段 |
| 2 `prepare_multi_box_excel` | 第一段成功 | `uv run --frozen python -m services.agent_cli.browser.amazon_fba.prepare_multi_box_excel --context-file "artifacts/amazon_fba/context_<consignment_no>.json"` | `notice == "第二阶段完成，已可选择自己的承运人，请执行第三阶段CLI。"` | 发送 `file_path` 中的附件 | 第三段 |
| 3 `confirm_own_carrier` | 已到自己的承运人页面 | `uv run --frozen python -m services.agent_cli.browser.amazon_fba.confirm_own_carrier --context-file "artifacts/amazon_fba/context_<consignment_no>.json"` | `notice == "恭喜第三步完成，现在需要输入追踪编码，请运行第四阶段脚本"` | 发送 `file_path` 中的附件 | 第四段 |
| 4 `enter_tracking_codes` | 第三段完成且已准备追踪号 | `uv run --frozen python -m services.agent_cli.browser.amazon_fba.enter_tracking_codes --context-file "artifacts/amazon_fba/context_<consignment_no>.json"` | `notice == "恭喜！创建货件流程完整结束！"` | 无附件要求 | 结束 |

## Result Handling

- 四段 stdout 都只读最后一条 `type=result` JSON。
- `params_ready=false` 或 `finished=false`：停止，只转述 `exception` 原文和必要 `context`。
- `finished=true`：按 `notice` 判断阶段状态；不要自行解释页面原因。
- `file_path` 是可发送附件路径数组；`value` 已在 workspace `artifacts/` 下，不要猜路径、不要改路径。
- CLI 成功后，如果 `file_path` 非空，必须逐个调用 `send_file(path="<file_path.value>")`。
- 如果 `send_file` 失败，只汇报对应路径和工具错误，不重跑 CLI。
- 后续步骤优先读最新 CLI 结果里的 `context`，不要靠长对话记忆。
