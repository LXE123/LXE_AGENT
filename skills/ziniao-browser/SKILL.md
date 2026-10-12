---
name: ziniao-browser
description: 通过受控 lxeskill 命令管理紫鸟店铺生命周期并观察、导航和操作店铺网页。用户要求打开、查看或退出紫鸟店铺，读取网页结构或截图，或在紫鸟浏览器内点击、输入、滚动和跳转时使用。
type: ziniao_browser
commands:
  - lxeskill browser store
  - lxeskill browser page
---

# 紫鸟浏览器

## 硬性规则

- 只通过 `exec` 独立调用上方两个 canonical `lxeskill` 命令；禁止直接调用 Python 模块、旧工具名或 shell 包装。
- 每次先检查 terminal 的 `ok`。成功时读取 `data`；失败时停止并原样转述 `error.message`，不要凭空补救。
- `store_id` 必须来自用户输入或 `get_status` 的真实结果，禁止猜测。
- 优先复用已运行店铺；只有状态明确为未运行时才 `open_store`。
- 复用指定站点页面且不允许启动或重启店铺时，每次页面命令都带 `--strict-attach --target-host <hostname>`；域名匹配为零或多个标签页时停止。
- snapshot 自动读取顶层及最多 10 个子 frame，返回 `Frames`、读取失败的实际错误和截断提示。frame 中的 ref 包含路径和 document 身份，必须完整原样传入 click/type；frame 变化时报错后重新 snapshot，不手工拼接或截短 ref。
- 页面有文字但没有 refs 时使用 `--full`，读取 `DOM diagnostics` 中的节点类型、role、class 和 cursor 等结构证据。诊断样本不是可操作 ref；仅有鼠标手形样式不证明节点绑定了点击行为。
- 零 refs 时 `structure_probe` 会优先列出手形节点，返回隐藏 selector 候选、计算样式、矩形、最多 4 层父级，以及页面暴露的 DOM/Vue/React 事件线索。`diagnostic_node` 只索引该 frame 的探针 `nodes` 表，不是 ref。探针不执行事件函数、不读取函数正文或组件状态；没有线索不排除事件委托或 `addEventListener`。读取并保留截断标记，不把截断或观察不到解释为不存在。
- 页面发生导航、点击、输入或滚动后，旧元素 `ref` 立即视为失效，下一次交互前重新执行 `browser_snapshot`。批量 `--steps` 内部按同一次附着执行，批尾会自动返回最新快照。
- 连续多步交互（如 click→type→click）必须合并为一次 `--steps` 批量调用，不要逐步单发。
- 除非用户明确要求结束店铺进程，否则不要执行 `exit_store`。

## 店铺生命周期

先查询当前状态：

```text
lxeskill browser store --action get_status
```

需要启动指定店铺时：

```text
lxeskill browser store --action open_store --store-id <store_id>
```

用户明确结束操作后才退出：

```text
lxeskill browser store --action exit_store --store-id <store_id>
```

`open_store` 成功后保留同一个 `store_id` 完成后续页面操作。店铺被重启后，不复用之前的页面状态或元素引用。

## 页面观察与操作

所有页面命令都必须带已运行的 `store_id`：

| action | 参数 | 用途与约束 |
|---|---|---|
| `browser_snapshot` | 无额外参数 | 返回页面 URL、标题、文本和可交互元素引用；每次交互前优先使用。 |
| `browser_vision` | 可选 `--full` | 生成截图。terminal 的 `data.screenshot_path` 是模型输入，不是默认发给用户的附件。 |
| `browser_navigate` | `--url <url>` | 跳转到明确 URL；随后重新 snapshot。 |
| `browser_click` | `--ref <ref>` | 点击最近一次 snapshot 中的元素；不得使用旧 ref。 |
| `browser_type` | `--ref <ref> --text <text>` | 向最近 snapshot 的输入元素写入文本；不要改写用户提供的文本。 |
| `browser_scroll` | `--direction up|down --pixels 100..4000` | 滚动页面；随后重新 snapshot。 |

示例：

```text
lxeskill browser page --action browser_snapshot --store-id <store_id>
lxeskill browser page --action browser_snapshot --store-id <store_id> --strict-attach --target-host <hostname>
lxeskill browser page --action browser_click --store-id <store_id> --ref <ref>
lxeskill browser page --action browser_type --store-id <store_id> --ref <ref> --text "<text>"
lxeskill browser page --action browser_scroll --store-id <store_id> --direction down --pixels 800
```

## 批量页面操作（steps）

连续交互优先使用批量模式：一次调用按顺序执行多步，共用一次浏览器附着，显著降低延迟。规则：

- `--steps` 与 `--action` 互斥；每个 `--steps` 值是一个紧凑单行 JSON 对象，最多 20 步。
- `ref` 来自上一次调用返回的 snapshot；批执行后结果会自动附带最新页面快照，无需再单独 snapshot。
- `browser_vision` 只能作为最后一步。
- 某步失败时批停止：结果逐条标注 ✓/✗，附失败原因与当前页面快照；已完成步骤不会回滚，按快照判断现场后再继续。

示例（填写表单并确认）：

```text
lxeskill browser page --store-id <store_id> --steps '{"action":"browser_click","ref":"aid-5"}' --steps '{"action":"browser_type","ref":"aid-7","text":"<text>"}' --steps '{"action":"browser_click","ref":"aid-9"}'
```

## 截图协议

执行：

```text
lxeskill browser page --action browser_vision --store-id <store_id> --full
```

成功后：

1. 从 terminal `data.screenshot_path` 读取已规范化绝对路径。
2. 使用 `read` 工具读取该图片，再根据画面继续判断。
3. 不要把截图路径当作普通文本回复，不要默认调用 `send_files`；只有用户明确索要截图文件时才发送。
4. 截图结果不含 base64；路径缺失、越界或文件不存在都视为命令失败。

## 错误恢复

- 遇到会话缺失、会话忙碌、店铺未启动、元素引用失效或页面状态不符时停止，不自动重启店铺或重复点击。
- 只有 terminal 明确提供 `recovery.command` 时，才可原样执行该命令；不得自行构造认证刷新命令。
- 恢复后先重新 `get_status`，再重新 `browser_snapshot`，不要沿用旧状态。
