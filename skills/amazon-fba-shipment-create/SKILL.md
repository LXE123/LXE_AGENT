---
name: amazon-fba-shipment-create
description: 用固定 CLI 完成 Amazon FBA 货件创建：第一段 prepare_upload；第二段 prepare_multi_box_excel；第三段 confirm_own_carrier；第四段 enter_tracking_codes。
type: amazon_store
---

## When to Use

- 用户要执行 Amazon FBA 货件创建。
- 用户已经提供 `store_id`、`site`、`consignment_no`、`transport_mode`，或当前任务就是先把这些字段补齐。
- 第一段上传完成后，如果用户要继续进入多包装箱 Excel 生成和自己的承运人确认步骤，也使用这个 skill。

## How to Execute

### 0. 连接目标店铺

1. 确认以下字段都已明确（缺任何一项就直接向用户追问，不要启动 CLI）：
   - `store_id` — 只接受 `ziniao_browser` 中的 `get_status` 返回的 `store_id`，不要猜店铺名或简称
   - `site` — 标准站点代码，如 `US`、`UK`、`DE`、`FR`、`IT`、`ES`、`CA`、`JP`
   - `consignment_no` — 托运单号
   - `transport_mode` — 运输方式业务输入，后续所有 CLI 结果都会原样回传
2. 使用紫鸟浏览器工具 `ziniao_browser` 中的 `open_store` 直接打开店铺（不要用 `attach_store`）。

### 注意 context 文件的输入格式
不要把 JSON 直接放进命令行参数。执行 CLI 前，先用 `write` 工具写入 `artifacts/amazon_fba/context_<consignment_no>.json`：

```json
{
  "store_id": "<store_id>",
  "site": "<site>",
  "consignment_no": "<consignment_no>",
  "transport_mode": "<transport_mode>"
}
```

四段 CLI 都使用这个 JSON 文件路径作为 `--context-file` 参数。
### 注意 
- 你唯一要做的事就是根据所处阶段执行下面的 CLI 脚本，不要尝试自己操作网页，毫无意义。你只需要关心目前状况需要执行哪个 CLI 脚本。出问题直接丢给用户就行。
-执行每一阶段的脚本后都可以直接结束当前对话，放心，系统后台会在任务有结果时通知你。
- 每一阶段的脚本执行成功后放心执行下一阶段的脚本。
- 如果你重启了店铺，意味着整个流程要重新开始。（从 prepare_upload 开始）

### 第一段：prepare_upload

```bash
uv run --frozen python -m services.agent_cli.browser.amazon_fba.prepare_upload --context-file "artifacts/amazon_fba/context_<consignment_no>.json"
```

用 `exec` 调用上述命令，然后按照下方 **CLI 结果解读规则** 处理返回。

第一段完成标志：
- `notice` 形如 `第一阶段完成，准备发送的 SKU：65（2185 件商品），请执行第二阶段CLI。`

### 第二段：prepare_multi_box_excel

前置条件：第一段已执行成功（`finished=true` 且无异常）。

```bash
uv run --frozen python -m services.agent_cli.browser.amazon_fba.prepare_multi_box_excel --context-file "artifacts/amazon_fba/context_<consignment_no>.json"
```

同样按照 **CLI 结果解读规则** 处理返回。第二段特有判断：
- 如果 `notice == "第二阶段完成，已可选择自己的承运人，请执行第三阶段CLI。"`，说明已到达第三步自己的承运人页面，第二段圆满完成。

### 第三段：confirm_own_carrier
如果看到使用您自己的承运人，请无条件使用第三段 CLI
前置条件：第二段已执行成功，且 `notice` 对应自己的承运人页面。

```bash
uv run --frozen python -m services.agent_cli.browser.amazon_fba.confirm_own_carrier --context-file "artifacts/amazon_fba/context_<consignment_no>.json"
```

第三段完成标志只有一个：
- `notice == "恭喜第三步完成，现在需要输入追踪编码，请运行第四阶段脚本"`

第三阶段有一个bug，如果返回这个 notice：
- `notice == "亚马逊店铺页面店铺出现bug，已返回第二步开头，请执行第二阶段CLI"` 出现这个，说明亚马逊店铺莫名其妙返回到第二步开头，直接执行第二阶段CLI即可

### 第四段：enter_tracking_codes
如果得到消息 “notice: "恭喜第三步完成，现在需要输入追踪编码，请运行第四阶段脚本"”，说明可以进入第四阶段了！

运行下面模块 CLI：
```bash
uv run --frozen python -m services.agent_cli.browser.amazon_fba.enter_tracking_codes --context-file "artifacts/amazon_fba/context_<consignment_no>.json"
```

第四段完成标志：
- `notice == "恭喜！创建货件流程完整结束！"`

---

## CLI 结果解读规则

四段 CLI 的 stdout 都只有一条 `type=result` JSON，只读以下六个字段：

| 条件 | 含义 |
|------|------|
| `params_ready=false` | 运行参数或前提不齐；优先读取 `exception` 原文，不要自行猜测是哪一层失败 |
| `params_ready=true` + `finished=false` | 执行中出现真实异常；只读 `exception` 原文，不要自行补充原因 |
| `params_ready=true` + `finished=true` + `notice=""` | 固定流程已完成，页面无上传失败提示 |
| `params_ready=true` + `finished=true` + `notice!=""` | 脚本已跑完，`notice` 是阶段提示或页面返回文本；只读原文，不要自行解释 |

- `file_path` 是 CLI 返回的真实本地路径数组，每项只有 `key` 和 `value`，不要猜路径。除非用户要求，否则不要输出这个。
- `context` 是 CLI 固定回传的业务上下文，始终包含(只用来保证长任务中不会丢失业务字段，除非用户要求，否则不要输出这个)：
  - `store_id`
  - `store_name`
  - `site`
  - `consignment_no`
  - `transport_mode`
- 后续步骤需要这些业务字段时，优先读最新 CLI 结果里的 `context`，不要靠长对话记忆。

---



