# LXE Agent

LXE Agent 是面向跨境电商运营团队的本地 AI 自动化助手。它把大模型、企业沟通渠道、业务系统和可复用工作流连接起来，帮助团队完成重复、跨系统且需要持续跟踪的运营任务。

当前 `main` 是 Electron 桌面产品线，正式分发目标为 Windows x64，也支持 macOS 源码开发和预览。独立终端产品见 [`lxe-agent-TUI`](https://github.com/LXE123/LXE_AGENT/tree/lxe-agent-TUI) 分支。

## 主要能力

- 在桌面直接创建会话、发送任务与附件、查看过程和停止任务，也可通过飞书私聊和群聊接收任务。
- AI 需要澄清时，桌面输入区显示问题卡片，支持单选、多选和自由回答；提交后继续当前任务。
- 提供 FBA 与补货工作流，覆盖马帮、紫鸟、报关、发票、采购和退税等场景。
- 在 Dashboard 中查看会话、任务、Skills、工具、模型、集成、统计和运行状态。
- 保存本地会话、JSONL transcript、任务和使用量记录，便于追踪执行过程。
- 支持 LXE Skills、MCP、Lark CLI、DingTalk CLI 和 Data Server 等扩展能力。
- 安装包自带 Node.js、Python 和命令行工具；桌面马帮认证使用 Electron 窗口，紫鸟业务使用用户配置的紫鸟客户端。

## 使用方式

1. 安装并启动 LXE Agent Desktop。
2. 连接公司云端并设置默认工作区；公司模型会自动启用，紫鸟、马帮和飞书等集成也可稍后补充。
3. 在桌面会话中直接发起任务，或使用已接入的飞书渠道；在 Dashboard 中查看执行状态和结果记录。
4. 关闭窗口后应用可继续在托盘运行；后台组件异常时可在桌面设置中检查状态或重启。

问题卡片等待期间可以切换会话，返回后继续回答。停止任务或重启 Agent 会让未回答的问题失效。

## 获取 LXE Agent

桌面版当前支持 Windows x64，使用完整离线 NSIS 安装程序分发。安装后无需系统提供 Bun、Node.js、Python、Go、uv 或 Playwright。

Windows 构建与安装验收见 [打包手册](docs/desktop/packaging-pipeline.md)。macOS 可运行源码版和生产页面预览，尚无正式签名、公证的安装包流水线。

## 产品版本

| 产品线 | 分支 | 适用场景 |
| --- | --- | --- |
| LXE Agent Desktop | `main` | Windows 桌面安装、会话交互、图形化管理；macOS 源码开发与预览。 |
| LXE Agent TUI | [`lxe-agent-TUI`](https://github.com/LXE123/LXE_AGENT/tree/lxe-agent-TUI) | 源码安装、终端命令、浏览器 Dashboard 以及自主管理开发环境。 |

两条产品线独立维护，不通过整体 merge 或 rebase 保持同步；公共修复会按需选择性移植。TUI 的安装方式和运行要求请直接查看对应分支 README。`main` 也提供可显式调用的 [一次性 Agent CLI exec](docs/harness/runtime/agent_cli_exec.md)，不需要切换分支才能使用它。

## 数据与隐私

- 公司下发的模型密钥与业务集成凭证由 Electron 安全存储加密保存；用户自带的本地模型 Key 明文保存在 `var/config/auth.json`，仅依靠当前用户的文件系统权限保护。
- 源码开发和预览将配置、会话及日志保存在当前 checkout 的 `var/`；Windows 安装包使用安装目录的 `var/`。
- Data Server 同步由配置和业务凭据控制，启用后按批上传回合用量统计。
- 真实业务 Excel、认证信息、日志和本地 `.env` 文件不会进入桌面安装包。

## 文档

- [Desktop 技术手册](docs/desktop/README.md)：进程架构、私有运行时、配置、开发和打包。
- [文档入口](docs/README.md)：使用手册、架构说明、有效决策和外部参考。
- [当前 Skill 清单](docs/harness/skill/current_skill_catalog.md)：正在运行的业务能力目录。

## License

Private Project - Internal Use Only.
