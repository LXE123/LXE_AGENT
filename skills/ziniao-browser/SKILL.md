---
name: ziniao-browser
description: 管理紫鸟浏览器会话，供查询、打开或退出店铺时使用。通过本机 Node.js 控制脚本截取当前页面，或运行业务 Skill 的固定网页流程。
type: ziniao_browser
commands:
  - lxeskill browser store
  - lxeskill browser script run
---

# 紫鸟浏览器

紫鸟在本项目中只用于登录和操作电商平台的卖家店铺后台，如 Amazon Seller Central。已有业务命令的流程按对应 Skill 执行。例如，创建 FBA 货件时，先用 `browser store` 取得 `store_id`，再按 `fba-shipment-create` 执行四阶段命令。

固定流程出错时，按业务 Skill 的失败说明处理，只有用户明确要求用紫鸟脚本排查或补救当前步骤时，才另行调用 `lxeskill browser script run`。

## 输入与依赖

- 通过 `exec` 调用 frontmatter 声明的 lxeskill 命令，页面操作由 CLI 内部的官方配对 Selenium 链路完成。
- 命令依赖当前 Agent 会话提供的 `LXE_AGENT_SESSION_ID` 和紫鸟客户端。
- `store_id` 来自用户输入或 `get_status` 的真实结果；页面操作使用已运行店铺的同一个 ID。

读取最后一条 `type="result"`，成功时查看 `data`，失败时报告 `error.message`。

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

## 运行紫鸟浏览器自动化脚本

为可复用的固定流程编写控制脚本，并随业务 Skill 提供。执行时传入运行中会话的 `store_id` 和流程需要的参数文件。

```text
lxeskill browser script run --store-id <ID> --script-file workflow.js --params-file params.json
```

入口文件是异步函数体，直接使用 `browser`、`params`、`await`、`return`。`params.json` 为 JSON 对象，可省略，默认 `{}`。脚本和参数文件相对于命令执行目录解析。独立安装 CLI 时，PATH 中需要有 Node.js；桌面安装包提供 Node。控制脚本拥有本地进程的权限。

单页读取可写成一行：

```javascript
return await browser.evaluate(({ selector }) => deepQuerySelector(selector)?.textContent ?? null, params);
```

需要截图时，在控制脚本中执行下面这一行。它通过 Selenium 截取当前标签页可见的网页区域，返回 PNG 文件的绝对路径。可以用 `read` 查看，用户索要图片时用 `send_files` 交付。

```javascript
return await browser.screenshot();
```

跨页时，由控制脚本等待每个步骤，并判断页面显示的业务结果。例如，在 `params` 中传入目标 URL、上传文件路径和文件输入框的选择器：

```javascript
await browser.navigate(params.formUrl);
await browser.runScriptFile("./fill.js", params);
await browser.uploadFile(params.fileInputSelector, params.uploadPath);
await browser.navigate(params.reportsUrl);
const path = await browser.download(() => browser.runScriptFile("./download-report.js", params));
return { path };
```

- `navigate(url)` 等待导航完成。动态组件的就绪状态由页面脚本按实际条件检查。
- `evaluate(fn, args)` 把函数发到当前页面执行。所需数据通过第二个参数传入，函数无法访问 Node 闭包。页面支持 `document`、`deepQuerySelector`、`deepQuerySelectorAll` 和 `deepClosest`。
- `runScriptFile(path, args)` 把独立 JS 函数体放入页面执行，以 `params` 读取传入对象。页面脚本遇到整页跳转可能中断，后续步骤放在控制脚本中。两个页面接口均可等待 Promise。
- `uploadFile(selector, path)` 定位唯一匹配的文件输入框。流程中的页面脚本路径和上传路径相对于控制脚本目录解析，也接受绝对路径。
- `download(trigger)` 按店铺下载目录的变化识别文件，沿用浏览器保存的文件名并返回归档路径。每次回调只触发一个下载，等待期间避免在同一店铺同时下载其他文件，以免取错文件或因出现多个候选而报错。

命令选取第一个普通网页标签，整次运行共用同一个连接和店铺锁。成功时，`data.result` 是脚本返回的 JSON 值，`data.downloads` 和 `data.screenshots` 分别列出下载文件和截图，`files` 包含两类附件。总时限默认 180 秒，使用 `--timeout-sec` 调整至 1～600 秒。超时或取消后，已发起的页面操作可能已经生效。如需重启店铺或重新提交业务操作，先核对实际状态并取得用户明确授权。
