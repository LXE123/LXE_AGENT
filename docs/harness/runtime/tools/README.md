# Runtime Tools

## 目的

本文说明工具的注册、模型可见范围、执行生命周期和结果处理。模块定位与内置工具清单见 [agentcli 模块介绍](../../../architecture/agentcli.md#2-tool-模块)；参数细节见下方专题。

Registry 保存工具定义和 handler，Runtime 按当前回合及步骤生成模型可见的 schema。调用统计由独立组件观察工具调用，见 [Tool Execution：Usage](tool_execution.md#usage)。

## 工具来源

- Native direct tools：Runtime 内置的 read/write/edit/grep/find/ls/send_files/exec/wait 等能力。
- Desktop interaction：`ask_user_question` 只对真实来源为桌面的当前回合开放，返回答案后继续同一工具调用。
- 外部命令：模型通过 `exec` 调用 `lxeskill`、`lark-cli` 等 CLI，不注册为独立的 model tool。lxeskill 的调用契约与统计归属查询见 [业务命令](tool_execution.md#lxeskill-业务命令)和 [Usage](tool_execution.md#usage)。
- MCP tools：从 enabled server 动态发现，可 direct 或 deferred。
- Skill-owned tools：只有允许的 skill 被激活后才暴露。
- `tool_search`：搜索 deferred definition 并更新 exposure state。

## 专题导航

- [Tool Schema](tool_schema.md)：definition、命名、JSON schema 和 exposure。
- [Tool Execution](tool_execution.md)：dispatch、cancel、result、artifact 与错误语义。
- [Ask User Question](ask-user-question.md)：问题卡片、专用答复接口和失效规则。

## 常用行为

- `find` 按 glob 搜索路径，`grep` 搜索文件内容。参数、忽略规则和输出限制分别见 [路径搜索](tool_schema.md#路径搜索-find)和 [内容搜索](tool_schema.md#内容搜索-grep)。
- `read` 可以读取文本和受支持的图片；已知二进制文件会明确拒绝。文本输出有统一上限，大文件通过 `offset` 和 `limit` 分段继续，不把整文件一次塞给模型。
- `ls` 支持目录分页，`edit` 支持同一文件的批量编辑。参数与边界见 [目录分页](tool_schema.md#目录分页-ls)和 [批量编辑](tool_schema.md#批量编辑-edit)。
- `exec` 在 Windows 使用 PowerShell，在 macOS/Linux 使用非登录 `/bin/sh`。它先观察最多 `yield-time-ms`；命令仍运行时返回 `exec_id`，不设默认硬超时。
- `wait` 只接受所属 Session 的 `exec_id`，返回上次成功观察后的新增输出；`terminate=true` 会终止完整进程树。v1 不提供 PTY、stdin、list 或重连。

这里描述稳定边界，不冻结容易变化的字符数、图片尺寸或缓存数字。需要核对参数时，以当前 tool schema 和测试为准。

## 事实来源

- [`registry.ts`](../../../../packages/agent/runtime/src/tooling/registry.ts)：工具注册与 exposure state。
- [`coding/register.ts`](../../../../packages/agent/runtime/src/tooling/coding/register.ts)：文件、搜索、exec/wait 和文件交付工具的装配入口。
- [`statistics/`](../../../../packages/agent/runtime/src/statistics/)：独立的调用统计与 `lxeskill list` 归属查询。
- [`mcp.ts`](../../../../packages/agent/runtime/src/tooling/mcp.ts)：MCP 配置、连接和工具注册。
- [`skills.ts`](../../../../packages/agent/runtime/src/tooling/skills.ts)：Skill 发现与提示词内容。
- [`runtime-host.ts`](../../../../apps/agent-cli/src/runtime-host.ts)：工具、MCP、工作区和 CLI scope 的宿主装配。

## Exposure 模型

Definition 注册与模型可见是两个不同阶段。Registry 保存所有可用 handler；每个 turn 创建独立 `ToolExposureState`：

- `exposure=direct` 且 policy 允许的工具立即可见。
- `exposure=deferred` 的工具先隐藏，命中 `tool_search` 后可见。
- 有 `ownerSkills` 的工具要求至少一个 owner skill 已激活。
- MCP 服务的启用状态由 MCP manager 管理。

平台过滤依据本轮任务来源，不根据会话最初来自哪里判断。Exposure state 在 turn 内持久，schema 每 step 重新捕获。新暴露的工具从下一 provider request 生效。

## 本机信任模型

- 重复工具名直接失败，不能静默覆盖 handler。
- 模型只能调用本 step schema 中已暴露的名称。
- tool input 必须是 object，并按 schema/handler 边界验证。
- `send_files` 可以交付当前进程可读取的任意普通文件；文件不存在或不是普通文件时失败。
- 现有文件 write/edit 必须先 read，并拒绝 read 后外部变化的 stale edit。

`exec`、`write`、`edit` 使用当前调用取得的会话权限策略。权限模式、生效时机、单次提权和平台限制统一见 [会话权限与工作区目录](../permission-policy.md)。

Skill 为模型提供工作上下文，具体操作通过工具执行。Skill 指引与程序模块依赖的区别，见 [PR 审查规范](../../../pr-review.md#21-skill-提供的工作上下文)。

## Cancel 与 exec 生命周期

所有 handler 接收当前 `RunHandle`。Provider、MCP 和本次 `exec`/`wait` 的观察会监听 turn abort；但进程一旦创建成功，所有权就立即转交 Session 级 manager。最终回复、turn 失败或取消只结束当前观察，不 kill 命令。命令可以在同一应用运行期、同一 Session 的后续 turn 继续用 `wait` 观察。

Session 删除、Runtime 停止和显式 `wait(terminate=true)` 会终止完整进程树。异步 exec 完成只发送 `background_task.changed` UI 事件，用于刷新原工具卡；它不写 pending event，也不触发 heartbeat、`agent.wake` 或外部渠道消息。

## Model-visible result

工具可以返回：

- `content`：进入 canonical tool result。
- `files`：由 Runtime 通过 emitter 发送 artifact。
- `state_patch`：合并到受控 session state。
- `display_status`：只控制当前工具卡展示，例如 yielded exec 保持 `running`；不进入 canonical tool result。

Tool result 在 append 前执行 token-aware 裁剪。模型、桌面、渠道和日志分别处理展示预算与脱敏；桌面可显示完整路径和 exec 命令。Transcript 和工具卡都不能直接当作已脱敏的导出副本，具体展示规则见 [Tool Execution](tool_execution.md#display-与日志)。

错误字段与归因规则见 [Result closure](tool_execution.md#result-closure)；实际错误的保留要求见 [AGENTS.md](../../../../AGENTS.md#红线违反--生产事故)。

## 非目标

工具执行会应用权限策略，但会话权限的持久化和审批由权限管理模块负责。平台发送位置与 provider retry 分别由 Gateway 和 Runtime 执行循环处理，模块分工见 [架构简介](../../../architecture/README.md)。
