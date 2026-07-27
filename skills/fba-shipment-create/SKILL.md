---
name: fba-shipment-create
description: 用固定 CLI 完成 Amazon FBA 创建货件流程。用户要求创建货件、上传装箱数据、生成多包装箱 Excel、确认自己的承运人、输入追踪号，或继续 prepare_upload / prepare_multi_box_excel / confirm_own_carrier / enter_tracking_codes 任一阶段时使用。
type: amazon_fba
commands:
  - lxeskill fba shipment confirm-own-carrier
  - lxeskill fba shipment enter-tracking-codes
  - lxeskill fba shipment prepare-multi-box
  - lxeskill fba shipment prepare-upload
---

# FBA Shipment Create

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只执行下方四段固定 CLI；不要手动操作 Seller Central 页面。
- 执行前使用独立 `ziniao-browser` skill 获取真实、已运行的 `store_id`；本 skill 不拥有浏览器命令。
- 紫鸟店铺被重启后，创建货件流程必须从第一段重来。
- 任一阶段失败时停止，只转述 terminal 的 `error.message` 和 `data.context`。
- 失败后不要刷新、截图诊断、重跑阶段、重启店铺或跨阶段补救，除非用户明确要求。
- 唯一自动回退例外：第三阶段 `notice == "亚马逊店铺页面店铺出现bug，已返回第二步开头，请执行第二阶段CLI"` 时，直接执行第二阶段。
- 后台命令仍在运行时只等待或读取该 session 结果，不重复启动同一阶段。

## Required Input

必须明确：

- `store_id`: 只接受独立 `ziniao-browser` skill 的 `get_status` 返回值。
- `site`: `US`、`UK`、`DE`、`FR`、`IT`、`ES`、`CA`、`JP`、`AU` 等标准站点代码。
- `consignment_no`: 托运单号。
- `transport_mode`: 运输方式业务输入，后续 CLI 会原样回传。

店铺名解析规则：

- 不要把紫鸟店铺名里的 `-US`、`-CA`、`-UK` 后缀当成业务站点约束。
- 用户给基础店铺名和站点时，先找完整店铺名；找不到再按去除站点后缀后的基础店铺名唯一匹配。
- `context.site` 仍写用户指定站点，由 CLI 进入店铺后切换站点。

## Context File

执行 CLI 前，用 `write` 工具创建 `artifacts/fba/shipment/context_<consignment_no>.json`；不要把 JSON 直接塞进命令行参数。

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
| 1 `prepare_upload` | context 已写好 | `lxeskill fba shipment prepare-upload --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `finished=true` 且 notice 提示第一阶段完成 | 发送 terminal `files` | 第二段 |
| 2 `prepare_multi_box_excel` | 第一段成功 | `lxeskill fba shipment prepare-multi-box --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `notice == "第二阶段完成，已可选择自己的承运人，请执行第三阶段CLI。"` | 发送 terminal `files` | 第三段 |
| 3 `confirm_own_carrier` | 已到自己的承运人页面 | `lxeskill fba shipment confirm-own-carrier --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `notice == "恭喜第三步完成，现在需要输入追踪编码，请运行第四阶段脚本"` | 发送 terminal `files` | 第四段 |
| 4 `enter_tracking_codes` | 第三段完成 | `lxeskill fba shipment enter-tracking-codes --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `notice == "恭喜！创建货件流程完整结束！"` | 无附件要求 | 结束 |

## Result Handling

- 四段 stdout 都只读最后一条 `type=result` JSON。
- `params_ready=false` 或 `finished=false`：停止，只转述 `exception` 原文和必要 `context`。
- 如果 `exception` 显示失败原因不明，提醒用户检查亚马逊 Seller Central 是否未切换到简体中文界面。
- `finished=true`：按 `notice` 判断阶段状态；不要自行解释页面原因。
- `data.file_path` 只为兼容旧调用方保留；正式附件唯一以 terminal `files` 为准。
- CLI 成功后，如果 terminal `files` 非空，必须逐个调用 `send_file(path="<terminal.files item>")`。
- 如果 `send_file` 失败，只汇报对应路径和工具错误，不重跑 CLI。
- 后续步骤优先读最新 CLI 结果里的 `context`，不要靠长对话记忆。
