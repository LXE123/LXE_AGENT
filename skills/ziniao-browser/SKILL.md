---
name: ziniao-browser
description: 通过 lxeskill 管理紫鸟店铺会话、读取页面结构或截图、操作卖家后台，并运行 JavaScript 控制脚本完成固定流程。
type: ziniao_browser
commands:
  - lxeskill browser store
  - lxeskill browser page
  - lxeskill browser script run
---

# 紫鸟浏览器

紫鸟在本项目中只用于登录和操作电商平台的卖家店铺后台，如 Amazon Seller Central。

## 输入与依赖

- 通过 `exec` 调用 frontmatter 声明的 lxeskill 命令，页面操作由 CLI 内部的官方配对 Selenium 链路完成。
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

## 运行紫鸟浏览器自动化脚本

在本机用 Node.js 运行 JS 控制脚本，通过 Selenium 操作紫鸟浏览器页面。已有业务脚本和本次任务编写的脚本使用同一入口。先从运行中的会话取得 `store_id`，再执行：

```text
lxeskill browser script run --store-id <ID> --script-file workflow.js --params-file params.json
```

入口文件是异步函数体，直接使用 `browser`、`params`、`await`、`return`。`params.json` 为 JSON 对象，可省略，默认 `{}`。脚本和参数文件相对于命令执行目录解析。独立安装 CLI 时，PATH 中需要有 Node.js；桌面安装包提供 Node。控制脚本拥有本地进程的权限。

单页读取可写成一行：

```javascript
return await browser.evaluate(({ selector }) => deepQuerySelector(selector)?.textContent ?? null, params);
```

跨页时，由控制脚本等待每个步骤，并判断页面显示的业务结果。例如，在 `params` 中传入目标 URL、上传文件路径和页面控件的选择器：

```javascript
await browser.navigate(params.formUrl);
await browser.runScriptFile("./fill.js", params);
await browser.uploadFile(params.fileInputSelector, params.uploadPath);
await browser.navigate(params.reportsUrl);
const path = await browser.download(() =>
  browser.evaluate(({ selector }) => deepQuerySelector(selector).click(), { selector: params.downloadSelector })
);
return { path };
```

- `navigate(url)` 等待导航完成。动态组件的就绪状态由页面脚本按实际条件检查。
- `evaluate(fn, args)` 把函数发到当前页面执行。所需数据通过第二个参数传入，函数无法访问 Node 闭包。页面支持 `document`、`deepQuerySelector`、`deepQuerySelectorAll` 和 `deepClosest`。
- `runScriptFile(path, args)` 把独立 JS 函数体放入页面执行，以 `params` 读取传入对象。页面脚本遇到整页跳转可能中断，后续步骤放在控制脚本中。两个页面接口均可等待 Promise。
- `uploadFile(selector, path)` 定位唯一匹配的文件输入框。流程中的页面脚本路径和上传路径相对于控制脚本目录解析，也接受绝对路径。
- `download(trigger)` 在回调触发下载前记录目录，在文件完成后返回归档路径。一个回调对应一个下载文件；多个候选时返回错误。

命令选取第一个普通网页标签，整次运行共用同一个连接和店铺锁。成功时读取 terminal 的 `data.result`（JSON 值）和 `files`（本次下载的附件）。总时限默认 180 秒，使用 `--timeout-sec` 调整至 1～600 秒。失败时读取实际错误；超时和取消无法回滚已经发起的页面操作，先核对页面状态再决定后续步骤。

## 截图

执行：

```text
lxeskill browser page --action browser_vision --store-id <store_id>
```

成功后，用 `read` 读取 terminal `data.screenshot_path` 指向的图片，再根据画面判断。CLI 会校验截图路径和文件；截图默认供模型观察，用户明确索要截图文件时再用 `send_files` 交付。

## 错误处理

`ok=false` 时保留 `error.message`，批内失败时保留 `data.content` 中的失败步骤与原因，并暂停当前交互；失败步骤可能已产生页面变化。

继续前确认会话与客户端可用，用 `get_status` 核对店铺状态，再从运行中的店铺获取 `browser_snapshot`。根据实际结果和用户授权确定下一步；需要重启店铺或重做提交时，先取得用户明确授权。
