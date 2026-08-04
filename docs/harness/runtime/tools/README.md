# Runtime Tools

状态：Current

## 目的

Runtime tool subsystem 把模型可见 schema、实际 handler、exposure policy、cancel、artifact 和 usage 统一在一个 registry 中。工具来源可以不同，但 provider 只看到当前 turn/step 允许的标准 definition。

## 工具来源

- Native direct tools：Runtime 内置的 read/write/edit/grep/find/exec/wait 等能力。
- 飞书远程渠道：Gateway 保留入站、回复、typing、附件与重连；Agent 主动读写飞书统一通过 `lark-cli` Skill，不再注册 Bot 专用原生读取工具。
- MCP tools：从 enabled server 动态发现，可 direct 或 deferred。
- Skill-owned tools：只有允许的 skill 被激活后才暴露。
- `tool_search`：搜索 deferred definition 并更新 exposure state。
- Business commands：不是独立 model tool；由 native `exec` 执行 catalog 注册的独立 `lxeskill ...` 命令。

## 专题导航

- [Tool Schema](tool_schema.md)：definition、命名、JSON schema 和 exposure。
- [Tool Execution](tool_execution.md)：dispatch、cancel、result、artifact 与错误语义。

## 常用行为

- `read` 可以读取文本和受支持的图片；已知二进制文件会明确拒绝。文本输出有统一上限，大文件通过 `offset` 和 `limit` 分段继续，不把整文件一次塞给模型。
- `exec` 在 Windows 使用 PowerShell，在 macOS/Linux 使用非登录 `/bin/sh`。它先观察最多 `yield-time-ms`；命令仍运行时返回 `exec_id`，不设默认硬超时。
- `wait` 只接受所属 Session 的 `exec_id`，返回上次成功观察后的新增输出；`terminate=true` 会终止完整进程树。v1 不提供 PTY、stdin、list 或重连。
- Desktop 的 Python、pip 和 `lxeskill` 使用应用私有 Python；源码开发才回退到项目 `.venv`。

这里描述稳定边界，不冻结容易变化的字符数、图片尺寸或缓存数字。需要核对参数时，以当前 tool schema 和测试为准。

## 事实来源

- [`registry.ts`](/packages/agent/runtime/src/tooling/registry.ts)：registry 与 exposure state。
- [`coding-tools.ts`](/packages/agent/runtime/src/tooling/coding-tools.ts)：文件、exec 和 wait 工具。
- [`lxeskill-command.ts`](/packages/agent/runtime/src/tooling/lxeskill-command.ts)：catalog 命令、owner 与 artifact 声明解析。
- [`mcp.ts`](/packages/agent/runtime/src/tooling/mcp.ts)：MCP config、连接和工具注册。
- [`skills.ts`](/packages/agent/runtime/src/tooling/skills.ts)：skill catalog 与 prompt。
- [`runtime-host.ts`](/apps/agent-cli/src/runtime-host.ts)：产品级工具、MCP、Workspace 和 CLI scope 装配。
- [`lark-im/SKILL.md`](/skills/larksuite-cli/lark-im/SKILL.md)：主动读取、搜索和发送飞书消息的统一入口。

## Exposure 模型

Definition 注册与模型可见是两个不同阶段。Registry 保存所有可用 handler；每个 turn 创建独立 `ToolExposureState`：

- `exposure=direct` 且 policy 允许的工具立即可见。
- `exposure=deferred` 的工具先隐藏，命中 `tool_search` 后可见。
- 有 `ownerSkills` 的工具要求至少一个 owner skill 已激活。
- connector/MCP disabled state 可以继续过滤 definition。

Exposure state 在 turn 内持久，schema 每 step 重新捕获。新暴露的工具从下一 provider request 生效。

## 安全边界

- 重复工具名直接失败，不能静默覆盖 handler。
- 模型只能调用本 step schema 中已暴露的名称。
- tool input 必须是 object，并按 schema/handler 边界验证。
- 文件操作限制在 workspace 与允许的 artifact/skill asset 路径。
- 现有文件 write/edit 必须先 read，并拒绝 read 后外部变化的 stale edit。
- root private env、用户数据库和本地 runtime state 受到写保护。
- Active business skill 不允许指导模型 shell-out 到业务模块。

## Cancel 与 exec 生命周期

所有 handler 接收当前 `RunHandle`。Provider、MCP 和本次 `exec`/`wait` 的观察会监听 turn abort；但进程一旦创建成功，所有权就立即转交 Session 级 manager。最终回复、turn 失败或取消只结束当前观察，不 kill 命令。命令可以在同一应用运行期、同一 Session 的后续 turn 继续用 `wait` 观察。

Session 删除、Runtime 停止和显式 `wait(terminate=true)` 会终止完整进程树。异步 exec 完成只发送 `background_task.changed` UI 事件，用于刷新原工具卡；它不写 pending event，也不触发 heartbeat、`agent.wake` 或外部渠道消息。

## Model-visible result

工具可以返回：

- `content`：进入 canonical tool result。
- `files`：由 Runtime 通过 emitter 发送 artifact。
- `state_patch`：合并到受控 session state。
- `display_status`：只控制当前工具卡展示，例如 yielded exec 保持 `running`；不进入 canonical tool result。

Tool result 在 append 前执行 token-aware 裁剪。日志和 CardKit 使用独立 display sanitizer；完整 result 不自动显示给用户，也不能泄露 secret、绝对敏感路径或 encrypted data。

错误结果使用统一的事实边界：`cause_known=false` 表示只能复述观测和安全下一步，不能从 HTTP status、异常文本或历史占位符猜原因；只有 `cause_known=true` 且带 `verified_reason` 的已分类错误才能作为归因依据。

## 非目标

Tool subsystem 不负责 session permission、平台发送位置或 provider retry。Router、GatewayEmitter 和 Runtime step loop 分别拥有这些职责。
