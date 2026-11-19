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

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# FBA 创建货件

按固定四阶段 CLI 在 Seller Central 推进创建货件（不手动操作页面）。

## 输入与前置规则

- **`store_id`**：执行前先通过独立 `ziniao-browser` skill 的 `get_status` 获取真实、已运行的 `store_id`（紫鸟店铺被重启后，创建货件流程必须从第一段重来）。
- **`site`**：仅支持 `US`、`UK`、`DE`、`FR`、`IT`、`ES`、`CA`、`JP`、`AU`、`SA`（沙特阿拉伯）、`AE`（阿联酋），不区分大小写，也接受中文国名；店铺须实际具备目标站点。
  - 店铺名解析：不要把 `-US`、`-CA`、`-UK` 后缀当成站点约束；用户给基础店铺名和站点时，先找完整店铺名，找不到再按去掉站点后缀后的基础店铺名唯一匹配；`context.site` 仍写用户指定站点，由 CLI 切换站点。
- **`consignment_no`**：托运单号。
- **`transport_mode`**：运输方式业务输入，后续 CLI 会原样回传。

## Context 文件

执行 CLI 前先写入 `artifacts/fba/shipment/context_<consignment_no>.json`（不直接把 JSON 塞进命令行参数）：

```json
{
  "store_id": "<store_id>",
  "site": "<site>",
  "consignment_no": "<consignment_no>",
  "transport_mode": "<transport_mode>"
}
```

## 四阶段流程

| Stage | 前置条件 | Command | 成功标志 | 附件行为 | 下一步 |
|---|---|---|---|---|---|
| 1 `prepare_upload` | context 已写好 | `lxeskill fba shipment prepare-upload --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `finished=true` 且 notice 提示第一阶段完成 | 发送 terminal `files` | 第二段 |
| 2 `prepare_multi_box_excel` | 第一段成功 | `lxeskill fba shipment prepare-multi-box --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `notice == "第二阶段完成，已可选择自己的承运人，请执行第三阶段CLI。"` | 发送 terminal `files` | 第三段 |
| 3 `confirm_own_carrier` | 已到自己的承运人页面 | `lxeskill fba shipment confirm-own-carrier --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `notice == "恭喜第三步完成，现在需要输入追踪编码，请运行第四阶段脚本"` | 发送 terminal `files` | 第四段 |
| 4 `enter_tracking_codes` | 第三段完成 | `lxeskill fba shipment enter-tracking-codes --context-file "artifacts/fba/shipment/context_<consignment_no>.json"` | `notice == "恭喜！创建货件流程完整结束！"` | 无附件要求 | 结束 |

- 命令返回 `status=running` 时保留 `exec_id`，仅用 `wait` 等待或读取新增输出，不重复启动同一阶段。
- **唯一自动回退例外**：第三阶段 `notice == "亚马逊店铺页面店铺出现bug，已返回第二步开头，请执行第二阶段CLI"` 时，直接执行第二阶段。

## 结果与异常处理

- 四段 stdout 均只把最后一条 `type="result"` 记录作为 terminal，先检查 `ok`；后续步骤优先读取最新结果中的 `context`。
- `params_ready=false`、`finished=false` 或任一阶段失败时立即停止，只转述 terminal 的 `error.message` / `exception` 原文和必要 `context`；未取得用户明确要求前，不刷新、截图诊断、重跑阶段、重启店铺或跨阶段补救。若失败原因不明，提醒用户检查亚马逊 Seller Central 是否已切换到简体中文界面。
- `finished=true` 时按 `notice` 判断阶段状态，不自行解释页面原因；`data.file_path` 仅为兼容旧调用方保留，正式附件唯一以 `terminal.files` 为准，非空时一次调用 `send_files(paths=<terminal.files>)`（若 `send_files` 失败只汇报失败路径和错误，不重跑 CLI）。
