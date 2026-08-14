# LXE Agent

LXE Agent 是面向跨境电商运营团队的本地 AI 自动化助手。它把大模型、企业沟通渠道、业务系统和可复用工作流连接起来，帮助团队完成重复、跨系统且需要持续跟踪的运营任务。

当前 `main` 是 Windows 桌面产品线；需要源码安装和终端运行方式时，请使用 [`lxe-agent-TUI`](https://github.com/LXE123/LXE_AGENT/tree/lxe-agent-TUI) 分支。

## 主要能力

- 通过飞书私聊和群聊接收任务，可选接入钉钉与其他集成。
- 提供 FBA 与补货工作流，覆盖马帮、紫鸟、报关、发票、采购和退税等场景。
- 在 Dashboard 中查看会话、任务、Skills、工具、模型、集成、统计和运行状态。
- 保存本地会话、JSONL transcript、任务和使用量记录，便于追踪执行过程。
- 支持 LXE Skills、MCP、Lark CLI、DingTalk CLI 和 Data Server 等扩展能力。
- 自带运行所需的 Node.js、Python、浏览器和命令行工具，不要求桌面用户预装开发环境。

## 使用方式

1. 安装并启动 LXE Agent Desktop。
2. 连接公司云端并设置默认工作区；公司模型会自动启用，紫鸟、马帮和飞书等集成也可稍后补充。
3. 通过已接入的企业沟通渠道发起任务，在 Dashboard 中查看执行状态和结果记录。
4. 关闭窗口后应用可继续在托盘运行；后台组件异常时可在桌面设置中检查状态或重启。

首版 Dashboard 定位为管理界面，会话交互主要通过飞书等渠道完成，不提供本地聊天输入框。

## 获取 LXE Agent

桌面版当前支持 Windows x64，使用完整离线 NSIS 安装程序分发。安装后无需系统提供 Bun、Node.js、Python、Go、uv 或 Playwright。

项目目前尚未公开发布 GitHub Release；内部测试请使用经过 Windows 平台门禁验证的 `Setup.exe`。macOS 目前只执行源码与构建验证，尚未提供包含完整私有运行时、签名和 notarization 的正式安装包。

## 产品版本

| 产品线 | 分支 | 适用场景 |
| --- | --- | --- |
| LXE Agent Desktop | `main` | Windows 桌面安装、图形化管理、私有运行时和后台托盘运行。 |
| LXE Agent TUI | [`lxe-agent-TUI`](https://github.com/LXE123/LXE_AGENT/tree/lxe-agent-TUI) | 源码安装、终端命令、浏览器 Dashboard 以及自主管理开发环境。 |

两条产品线独立维护，不通过整体 merge 或 rebase 保持同步；公共修复会按需选择性移植。TUI 的安装方式和运行要求请直接查看对应分支 README。

## 数据与隐私

- 公司下发的模型密钥与业务集成凭证由 Electron 安全存储加密保存；用户自带的本地模型 Key 明文保存在 `var/config/auth.json`，仅依靠当前用户的文件系统权限保护。
- 会话、任务和运行记录默认保存在本机应用数据目录。
- Data Server 是可选能力；只有完成配置并启用后才会上传会话快照。
- 真实业务 Excel、认证信息、日志和本地 `.env` 文件不会进入桌面安装包。

## 文档

- [Desktop 技术手册](docs/desktop/README.md)：进程架构、私有运行时、配置、开发和打包。
- [文档入口](docs/README.md)：当前可信文档、状态标签和归档说明。
- [当前 Skill 清单](docs/harness/skill/current_skill_catalog.md)：正在运行的业务能力目录。

## License

Private Project - Internal Use Only.
