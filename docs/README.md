# 文档入口

面向 `main` 桌面产品线。产品介绍从 [项目 README](../README.md) 开始；独立 TUI 的安装和运行说明以对应分支为准。

## 1. 协作与审查规范

回答“怎样修改、验证和审查项目”。

- [PR 审查规范](pr-review.md)：协作流程、审查分工、人工审核项及 PR 描述要求。
- [AGENTS.md](../AGENTS.md)：AI 代理的工作要求、工具链和开发流程。
- [开发脚本](../scripts/README.md)：worktree 领取与归还；[跨机器同步](repository-sync.md)：Mac 与 Windows 的仓库同步操作。

## 2. 架构说明

回答“项目由什么组成，各部分负责什么、如何协作”。

- [架构简介](architecture/README.md)：整体关系、数据归属和共享运行依赖。
- [Electron 模块介绍](architecture/electron.md)：用户入口、桌面交互、Gateway 与系统集成。
- [agentcli 模块介绍](architecture/agentcli.md)：独立 Agent Harness 的职责划分。
- [lxeskillCLI 模块介绍](architecture/lxeskill-cli.md)：业务 CLI 的命令、业务执行和数据管理。

## 3. 技术手册

回答“当前机制如何工作，怎样使用、开发和排查”。

技术手册按模块归属收纳：`desktop/` 对应 Electron（含 Gateway），`harness/` 对应 agentcli，`lxeskill-cli/` 对应业务 CLI。跨模块专题集中维护一篇，由相关模块引用；外部参考暂保留原目录，通过下方参考资料入口查阅。

### Electron 与 Gateway

- [Desktop 技术手册](desktop/README.md)：桌面开发、配置与专题入口。
- [构建、打包、安装与启动](desktop/packaging-pipeline.md)、[Windows 更新与发布](desktop/updates.md)：构建链路、发布操作和客户端更新。
- [工作区与对话](desktop/conversation-window.md)、[输入框引用](desktop/composer-references.md)、[会话状态](desktop/session-status.md)、[结构化提问](harness/runtime/tools/ask-user-question.md)：对话交互及对应技术机制。
- [定时任务与桌面 MCP](desktop/automations.md)：两种会话方式、调度、持久化与本机工具接口。
- [侧边栏与文件预览](desktop/file-preview.md)：文件查看、手动终端与浏览器。
- [Gateway](desktop/gateway/README.md)、[生命周期](desktop/gateway/gateway_lifecycle.md)：渠道接入、路由、调度、结果交付和启停及进程关系。
- [Gateway ↔ agentcli 协议](desktop/gateway/agent-protocol.md)：JSON-RPC、握手、事件和错误。
- [云端接入、凭据与权限](desktop/cloud-access.md)：自动设备发现、公司模型与网页登录；[旧身份迁移](desktop/identity-migration.md)、[权限兼容与迁移](desktop/permission-migration.md)、[Mac WireGuard 服务](desktop/macos-wireguard-service.md)补充维护操作。
- [程序与用户数据](desktop/data-location.md)：数据目录、安装与升级迁移。

### agentcli

- [Skill 手册](harness/skill/README.md)：发现、加载、用户管理和统计机制；业务指引正文位于 [skills/](../skills)，可从 [FBA](../skills/fba-workflow-map/SKILL.md)和 [补货](../skills/replenishment-workflow-map/SKILL.md)入口查找。
- [Runtime](harness/runtime/README.md)、[执行流程](harness/runtime/turn_execution.md)：宿主装配与回合执行。
- [上下文](harness/runtime/context/README.md)：消息、组装、压缩与持久化。
- [工具](harness/runtime/tools/README.md)、[权限专题](harness/runtime/permission-policy.md)：注册、执行、写入范围与单次审批。
- [LLM 适配](harness/llm/README.md)、[模型目录与选择](harness/llm/provider_catalog.md)：协议适配、流式响应及本地／公司模型配置。
- [Agent CLI exec](harness/runtime/agent_cli_exec.md)：一次性终端调用与独立会话存储。
- [统计上传](harness/runtime/native-statistics-upload.md)：用量同步、确认和失败恢复；[赛狐 MCP](saihu-device-access.md)：连接配置与设备鉴权。

### lxeskillCLI

- [马帮浏览器认证](../python/lxeskill_cli/browser_auth_service/README.md)：桌面认证窗口、独立 CLI 浏览器绑定和排障。
- [CLI 云端通信与自检](lxeskill-cli/cloud-access.md)：权限查询、连接诊断、公共 HTTP 模块和业务请求。
- [越南备货实现说明](lxeskill-cli/vietnam-replenishment.md)：输入快照、设置保存、校验和工作簿生成。
### 共享能力与诊断

- [Office 文件能力](office-runtime.md)：Electron、模型与业务 CLI 的 Office 接口及运行依赖。
- [本地数据与存储](storage/README.md)、[日志与诊断](logging.md)：存储布局、备份和排障。

### 参考资料

[平台参考资料](harness/skill/reference/README.md)保存供应商 API、真实响应和紫鸟自动化约束；[CDS 设计资料库](design/cds/README.md)保存设计来源与 LXE 适配案例；[Codex 工具载荷研究](study/codex-code-mode-tool-payload.md)记录外部项目研究。原始材料说明来源和证据范围，不能代替当前项目手册或运行时 Skill。

## 4. 变更与历史记录

回答“当时为什么这样改，改了什么，验证到了哪里”。

- [验收记录](acceptance/README.md)：按主题查看已执行的验证、当时环境及未完成事项。
- [事故记录](incidents/README.md)：已知事实、调查状态和待解决问题。
- [历史分叉整合](record/repository-sync-integration.md)：Mac／Windows 来源提交与当时处理范围；日常操作见仓库同步手册。
- [决策记录](record/)：例如 [仓库结构](record/20260714-repo-structure-contract.md)、[导出流水线边界](record/20260714-mabang-export-pipeline-evaluation.md)、[Transcript v2](record/20260715-transcript-v2.md)、[产品分支](record/20260716-product-lines-branch-migration.md)、[宿主装配](record/20260718-agent-host-composition-boundary.md)、[Workspace Instance](record/20260718-workspace-instance-domain.md)和 [模型消息领域](record/20260905-assistant-message-domain.md)。[早期客户端身份方案](record/20260910-client-identity-v1.md)保留历史背景，当前云端访问从技术手册进入。
- 版本更新说明随 [发布配置](../config/desktop-release.json)维护，发布操作见 [Windows 更新与发布](desktop/updates.md)。

### 文档维护

- 规范、架构和技术手册描述当前情况；每个主题确定主要维护位置，其他文档简述并引用。相关实现变化时更新正文与导航，易变版本和参数链接到代码或契约。
- 历史记录注明日期或版本，保留当时事实；仍需使用的迁移与回退步骤保留在技术手册。一次验收通过不代表当前版本已验证，未解决事故保留调查状态。
- 合并重复内容后修复引用并删除无独立价值的旧页，历史可从 Git 查询。设计资料和外部参考保留原始证据，不复制完整 Skill 提示词，不保存实际凭据或业务数据。
