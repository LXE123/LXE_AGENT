# Agent Runtime

Runtime 是 agentcli 的执行核心，负责模型调用、上下文、工具执行、会话持久化、执行权限和统计。模块定位与协作边界见 [agentcli 架构](../../architecture/agentcli.md)；本目录说明具体运行机制。

## 宿主与执行入口

[`AgentRuntimeHost`](../../../apps/agent-cli/src/runtime-host.ts) 装配 Store、Provider、权限服务、SkillCatalog、工具与进程管理、MCP、统计上传和 Workspace 服务。桌面模式下，它运行在独立的 `agent-cli` 子进程中；Gateway 通过 [JSON-RPC 2.0](../../desktop/gateway/agent-protocol.md) 提交任务，使用 stdin/stdout 传输。

[独立 CLI exec](agent_cli_exec.md) 复用同一个宿主，直接提交任务，并使用独立于桌面的会话数据库。Runtime 返回执行事件和结果；渠道路由、排队和最终发送位置由 Gateway 管理。

模型通过通用 `exec` 调用 lxeskillCLI 等外部程序。Runtime 不加载业务 CLI 的 Python 模块或 `catalog.json`；针对 lxeskill 的统计适配通过公开命令查询归属，具体见 [Skill 与统计](../skill/README.md#读取调用与命令统计)。

## 专题导航

| 需要了解什么 | 主要维护位置 |
| --- | --- |
| 一次 turn 如何推进，step、工具、steering 和取消如何衔接 | [执行流程](turn_execution.md) |
| Gateway 与 agentcli 如何通信 | [JSON-RPC 2.0 契约](../../desktop/gateway/agent-protocol.md) |
| 进程如何装配、启动、停止与回滚 | [Gateway 与 Agent 生命周期](../../desktop/gateway/gateway_lifecycle.md) |
| 历史如何组装、压缩和持久化 | [Context](context/README.md) |
| 模型定义从哪里来，如何选用和适配 | [模型目录](../llm/provider_catalog.md)、[LLM 适配](../llm/README.md) |
| 每个会话的模型选择如何保存 | [会话模型与 effort](session-models.md) |
| 会话标题如何生成、改名与恢复 | [会话标题](session-titles.md) |
| Tool 如何暴露、执行和管理进程 | [工具手册](tools/README.md) |
| 文件写入范围、权限模式和单次提权 | [权限专题](permission-policy.md) |
| 工作区指令与 Skill 元数据如何缓存、刷新 | [Workspace Instance](workspace_instances.md)、[Skill 手册](../skill/README.md) |
| 状态、统计与诊断存在哪里 | [本地数据与存储](../../storage/README.md)、[统计上传](native-statistics-upload.md)、[日志与诊断](../../logging.md) |

实现入口为 [`runtime.ts`](../../../packages/agent/runtime/src/engine/runtime.ts)。工具、策略与架构变更的审查要求统一见 [PR 审查规范](../../pr-review.md)。
