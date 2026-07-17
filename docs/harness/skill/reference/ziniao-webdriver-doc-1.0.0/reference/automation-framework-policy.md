# 自动化框架选型约束（Selenium-only）

**本仓库对紫鸟店铺浏览器的一切页面级控制，必须走紫鸟官方配对的 Selenium 链路（`SeleniumRunner` + 按 `core_version` 配对的 chromedriver 二进制）。禁止引入 Playwright、Puppeteer 或裸 CDP 客户端做页面级操作。**

## 依据

紫鸟官方文档明确警示（2026-07 官方人员亦确认）：

> 使用 Playwright 框架对接紫鸟浏览器，会被常规风控检测为自动化程序，存在账号、店铺风控风险，需要开发者自行额外处理特征伪装、环境脱敏等适配工作。为保障店铺稳定性、降低风控概率，官方优先推荐使用 Selenium 框架进行自动化开发。

技术背景：站点风控检测自动化依赖页面内可观察的痕迹（`navigator.webdriver`、chromedriver 注入标记、CDP 客户端行为泄漏如 `Runtime.enable`）。紫鸟的定制内核与其发行的按 core 版本配对的 chromedriver 成对做了反检测处理；Playwright/Puppeteer 的默认 CDP 行为模式不在该适配范围内。**按 `core_version` 管理 chromedriver 二进制（`driver_folder_path`）不是可消除的运维负担，而是风控适配契约的组成部分。**

## 豁免

仅限不触碰页面 JS 执行环境的带外操作：

- 对 `debuggingPort` 的 CDP HTTP 元信息端点做只读健康检查（如 `GET /json/version`）；
- 对紫鸟客户端控制端口（`ZINIAO_SOCKET_PORT`）的 `getBrowserList` / `getRunningInfo` 等只读查询。

页面内容的读取、截图、导航、点击、输入一律不豁免。

## 相关

- 运行中店铺的真实 `getRunningInfo` 字段样本：[samples-get-running-info.md](samples-get-running-info.md)
- 紫鸟 WebDriver 核心 API：[api-core.md](api-core.md)
