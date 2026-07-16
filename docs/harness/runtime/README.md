# TypeScript Runtime

状态：Current

## 先说结论

Runtime 是 Agent 的执行核心，负责一个 turn 里的 Context、模型调用、工具执行、streaming、持久化和 usage。它运行在私有 `agent-cli` 子进程中，不在 Electron Main 里直接运行。

Gateway 通过版本化 NDJSON 协议提交任务和取消请求。Runtime 只返回执行事件和结果，不解析飞书事件，也不决定结果应该发到哪个聊天窗口。

## 主要职责

| 领域 | Runtime 做什么 |
| --- | --- |
| Turn | 固定本轮 provider 与权限快照，执行 step loop，返回 completed、cancelled 或 error |
| Context | replay 历史、修复工具闭合、估算预算并按需压缩 |
| Provider | 适配模型请求、处理 stream、retry、overflow 和 usage |
| Tools | 管理 native、MCP、deferred 和 skill-owned 工具 |
| Storage | 写 Agent SQLite、Transcript v2、usage 和可重建索引 |
| Observability | 记录脱敏后的 turn、provider、tool trace |

平台权限、session binding、排队和 response route 属于 Gateway。窗口、托盘、加密凭证和子进程生命周期属于 Electron Main。

## 运行边界

- Runtime 收到的任务已经带有稳定的 session、turn 和 response route 标识。
- 每个 turn 开始时固定 provider、system prompt 和允许的 skill；工具 exposure 可以从下一 step 开始变化。
- assistant tool call 先持久化，tool result 执行后立即闭合并持久化。
- cancel 会传给 provider、summary、MCP 和工具进程，未执行的 tool call 会写明确的关闭结果。
- 业务 Python 不作为常驻服务加载。模型只能通过 native `exec` 启动一条受 catalog 管理的 `lxeskill ...` 命令。
- Runtime 只产生出站意图；真正的平台发送由 GatewayEmitter 完成。

## 进程内生命周期

`agent-cli` 启动 Runtime 时，先打开 Agent store，再启动 process manager、维护任务和 MCP 等服务。任一服务启动失败时，已经启动的部分按反向顺序清理。

桌面退出时，Gateway 先停止 ingress 和 active work，再关闭 `agent-cli`。Runtime 不自行接管或重放 Gateway 尚未完成的任务。

## 专题导航

- [Runtime Flow](runtime_flow.md)：从平台消息到最终 delivery 的端到端边界。
- [Turn Execution](turn_execution.md)：turn snapshot、provider、tool 和 final outcome。
- [Turn Step Lifecycle](turn_step_lifecycle.md)：单个 step 的固定顺序。
- [Context](context/README.md)：history、预算、Transcript v2 和 compaction。
- [Tools](tools/README.md)：工具可见性、执行、进程和业务命令边界。

## 核心原则

1. Runtime 不持有平台 SDK，也不绕过 Gateway 直接发消息。
2. 每次 provider request 使用闭合、可预算的 canonical history。
3. Context 压缩失败时保留原历史，不做静默删除。
4. 工具业务执行和 artifact delivery 分开，发送失败不重跑工具。
5. Transcript、usage 和 trace 不记录 secret 或未脱敏的 thinking data。

实现事实来源是 [Runtime source](/packages/agent/runtime/src) 和对应测试；桌面进程关系见 [Gateway](../gateway/README.md) 与 [Desktop 技术手册](../../desktop/README.md)。
