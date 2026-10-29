---
name: ziniao-browser
description: 通过受控 lxeskill 命令管理紫鸟店铺会话，用于登录和操作电商平台的卖家店铺后台。用户要求打开、查看或退出紫鸟店铺，读取后台网页结构或截图，或执行点击、输入、滚动和跳转时使用。
type: ziniao_browser
commands:
  - lxeskill browser store
  - lxeskill browser page
---

# 紫鸟浏览器

紫鸟在本项目中只用于登录和操作电商平台的卖家店铺后台，如 Amazon Seller Central。

## 输入与依赖

- 通过 `exec` 调用 frontmatter 声明的两个 lxeskill 命令，页面操作由 CLI 内部的官方配对 Selenium 链路完成。
- 命令依赖当前 Agent 会话提供的 `LXE_AGENT_SESSION_ID` 和紫鸟客户端。
- `store_id` 来自用户输入或 `get_status` 的真实结果；页面操作使用已运行店铺的同一个 ID。

读取最后一条 `type="result"` 作为 terminal：先检查 `ok`，成功时读取 `data`，失败时按下文“错误处理”处理。

## 店铺生命周期

先查询当前状态：

```text
lxeskill browser store --action get_status
```

复用已运行店铺；状态明确为未运行且任务需要启动时：

```text
lxeskill browser store --action open_store --store-id <store_id>
```

用户明确要求结束店铺进程时退出：

```text
lxeskill browser store --action exit_store --store-id <store_id>
```

## 页面观察与操作

所有页面命令都带 `store_id`。先执行 `browser_snapshot` 获取页面和元素 `ref`；单步导航、点击、输入或滚动后，下次交互前重新获取快照。店铺重启后同样重新观察。批量模式的快照处理见下一节。

| action | 参数 | 用途与约束 |
|---|---|---|
| `browser_snapshot` | 可选 `--full` | 返回页面 URL、标题、文本和可交互元素引用；`--full` 增加快照内容。 |
| `browser_vision` | 无额外参数 | 生成截图，读取方式见“截图”。 |
| `browser_navigate` | `--url <url>` | 跳转到指定 URL。 |
| `browser_click` | `--ref <ref>` | 点击最近快照中的元素。 |
| `browser_type` | `--ref <ref> --text <text>` | 向最近快照的输入元素写入用户指定文本。 |
| `browser_scroll` | `--direction up|down --pixels 100..4000` | 按方向和像素数滚动。 |

示例：

```text
lxeskill browser page --action browser_snapshot --store-id <store_id>
lxeskill browser page --action browser_click --store-id <store_id> --ref <ref>
lxeskill browser page --action browser_snapshot --store-id <store_id>
```

## 批量页面操作（steps）

已从当前快照确定目标的连续交互优先使用批量模式，共用一次浏览器附着以降低延迟。需要观察前一步结果才能决定后续操作时，分次执行。

- `--steps` 与 `--action` 互斥；每个 `--steps` 值是一个紧凑单行 JSON 对象，最多 20 步。
- `ref` 来自上一次调用返回的 snapshot；批执行后结果会自动附带最新页面快照，无需再单独 snapshot。
- `browser_vision` 只能作为最后一步。
- 检查 `data.content` 中逐步标注的 ✓/✗；某步失败时批停止，附失败原因与可用的当前页面快照。已完成步骤不会回滚，后续按“错误处理”核对现场。

示例（填写表单并确认）：

```text
lxeskill browser page --store-id <store_id> --steps '{"action":"browser_click","ref":"aid-5"}' --steps '{"action":"browser_type","ref":"aid-7","text":"<text>"}' --steps '{"action":"browser_click","ref":"aid-9"}'
```

## 截图

执行：

```text
lxeskill browser page --action browser_vision --store-id <store_id>
```

成功后，用 `read` 读取 terminal `data.screenshot_path` 指向的图片，再根据画面判断。CLI 会校验截图路径和文件；截图默认供模型观察，用户明确索要截图文件时再用 `send_files` 交付。

## 错误处理

`ok=false` 时保留 `error.message`，批内失败时保留 `data.content` 中的失败步骤与原因，并暂停当前交互；失败步骤可能已产生页面变化。

继续前确认会话与客户端可用，用 `get_status` 核对店铺状态，再从运行中的店铺获取 `browser_snapshot`。根据实际结果和用户授权确定下一步；需要重启店铺或重做提交时，先取得用户明确授权。
