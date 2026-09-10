# 文档入口

面向 `main` 桌面产品线。产品介绍从 [项目 README](../README.md) 开始；独立 TUI 的安装和运行说明以对应分支为准。

## 使用与开发

- [Desktop 技术手册](desktop/README.md)：桌面交互、进程边界、配置和开发入口。
- [构建、打包、安装与启动](desktop/packaging-pipeline.md)：源码验证、Windows 分发和安装验收。
- [桌面对话窗口](harness/conversation-window.md)、[会话状态](desktop/session-status.md)、[结构化提问](harness/tool/ask-user-question.md)：聊天、附件、等待回答和停止任务。
- [客户端身份与后台登录](record/20260910-client-identity-v1.md)、[Mac WireGuard 服务](harness/desktop/macos-wireguard-service.md)：设备接入与身份边界。
- [马帮浏览器认证](../python/lxeskill_cli/browser_auth_service/README.md)：Electron 认证窗口、独立 CLI 浏览器绑定和排障。
- [日志与诊断](harness/logger.md)、[事故记录](incidents/README.md)：日志位置、脱敏和未解决问题。

## 架构与契约

- [桌面事件循环](eventloop.md)：进程、任务所有权和退出顺序。
- [Gateway](harness/gateway/README.md)：平台接入、路由、调度、取消和出站。
- [Gateway ↔ Agent 协议](record/20260715-agent-cli-stream-json.md)：JSON-RPC、握手、事件和错误。
- [Runtime](harness/runtime/README.md)：执行回合、上下文、持久化和工具。
- [Agent CLI exec](harness/runtime/agent_cli_exec.md)：一次性终端调用与独立会话存储。
- [LLM 适配](harness/llm/README.md)：模型目录、三类协议适配和流式响应。
- [工具](harness/runtime/tools/README.md)：可见性、宿主机权限、执行和进程生命周期。
- [本地状态与数据库](database/local_agent.md)：Bun、Gateway、Python 的状态归属。
- [仓库结构契约](record/20260714-repo-structure-contract.md)：目录规则和配套校验。

`record/` 保留仍有独立价值的决策，例如 [命令契约差异](record/20260714-l3-command-contract-deviations.md)、[导出流水线边界](record/20260714-mabang-export-pipeline-evaluation.md)、[Transcript v2](record/20260715-transcript-v2.md)、[产品分支](record/20260716-product-lines-branch-migration.md)、[宿主装配](record/20260718-agent-host-composition-boundary.md)、[Workspace Instance](record/20260718-workspace-instance-domain.md) 和 [模型消息领域](record/20260905-assistant-message-domain.md)。日期表示决策背景，使用时结合对应专题和当前代码。

## Skills 与参考资料

运行时提示词在 [skills/](../skills)，发现和权限规则见 [Skill 手册](harness/skill/README.md)，业务目录见 [Skill 清单](harness/skill/current_skill_catalog.md)。工作流入口是 [FBA](../skills/fba-workflow-map/SKILL.md) 和 [补货](../skills/replenishment-workflow-map/SKILL.md)。

[平台参考资料](harness/skill/reference/README.md) 保存供应商 API、真实响应和紫鸟自动化约束；[Codex 工具载荷研究](study/codex-code-mode-tool-payload.md) 是外部项目资料。它们不定义 LXE 的当前实现，也不能替代运行时 Skill。

## 维护规则

- 产品行为以当前代码及测试为准；文档说明稳定边界，易变版本和参数链接到对应契约。
- 每个主题维护一个主要入口。行为变更时同步更新相关手册和导航，不只追加日期记录。
- 已被取代的草稿、重复迁移说明和阶段清单直接删除，历史从 Git 查询。
- 外部参考标明来源，未完成事故保留调查状态；不要给未经核对的文档盖上 `Current` 标签。
- 不复制完整 Skill 提示词，不在文档中保存实际凭据或业务数据。
