# Gateway

## 先说结论

Gateway 是桌面应用里的“接待和调度中心”。它运行在 Electron Main 中，负责接收桌面任务和飞书消息、检查权限、找到会话、安排执行顺序，再把结果送回对应入口。

真正调用模型和工具的是私有 `agent-cli` 子进程里的 Runtime。`agent-cli` 自己拥有 `AgentRuntimeHost` composition root，装配 Agent store、provider、Runtime、MCP、Python CLI、Workspace、工具和 Dashboard 查询。Gateway 不直接执行 turn，也不依赖 Runtime package；它只通过版本化 NDJSON 协议向宿主发任务、取消和查询请求。

## 当前主链路

```mermaid
flowchart LR
    A["飞书事件"] --> B["Electron Main<br/>Gateway"]
    UI["桌面会话 / 问题卡片"] <-->|"preload IPC"| B
    B --> C["权限 / 会话 / 调度"]
    C <-->|"NDJSON"| D["私有 agent-cli"]
    D --> E["TypeScript Runtime<br/>模型 / Context / Tools"]
    E --> D
    D --> B
    B --> F["GatewayEmitter"]
    F --> G["飞书 CardKit / 消息 / 文件"]
```

Dashboard 也不直接连接 Runtime。Renderer 先通过白名单 IPC 发送类型化 `{ operation, input }` 调用；需要 Agent 数据时，Main 再通过同一套私有协议调用 `agent-cli`，不模拟 HTTP 请求或响应。

## 谁负责什么

| 组件 | 主要职责 | 不负责 |
| --- | --- | --- |
| Electron Main | 管理桌面生命周期、配置、凭证和子进程 | 不执行模型 turn |
| Gateway | 平台接入、权限、session binding、排队、取消和结果路由 | 不调用模型或业务工具 |
| `agent-cli` | 装配并承载 Runtime、Agent 数据库、provider、MCP、Python CLI、Workspace、Agent 工具和 Dashboard Agent API | 不接收平台 webhook，不决定平台授权 |
| Runtime core | Context、模型调用、工具、transcript 和 usage | 不持有 channel/出站平台 SDK，不决定消息发到哪里 |
| GatewayEmitter | 根据 response route 发送 stream、文件和最终结果 | 不改变 Runtime 已完成的业务结果 |

这种拆分最重要的好处是：平台接入和模型执行互不越界。Runtime 崩溃或重启时，Electron Main 仍能报告健康状态；平台发送失败时，也不会让已经执行成功的工具重新运行。

## 调度与失败边界

- Router 在创建任务前完成权限、session source 和 response route 校验。
- Scheduler 保证同一个 session 串行执行；不同 session 没有全局并发数量门槛，调度仍受 Runtime readiness 约束。
- `/stop` 和桌面停止操作走取消链；steering 通过独立队列在安全边界消费。取消中止 provider、MCP、问题等待和 exec/wait 观察，桌面退出还会关闭 Runtime 并清理 Session 进程。
- Runtime 子进程短暂异常时，Gateway 停止接收新任务并按受控策略重启；不会偷偷切换到同进程 Runtime。
- 平台发送失败只影响 delivery，不回滚 transcript，也不重跑已完成工具。
- exec 完成只发送 `background_task.changed` 刷新工具卡，不写 pending event，也不唤醒模型；heartbeat/wake 保留给其他自主调度来源。
- 结构化答案通过 `sessions.answer` 直接提交给 Runtime，不能进入普通任务或 steering 队列。查询和生命周期见 [结构化提问](../tool/ask-user-question.md)。

## 专题导航

- [Gateway Lifecycle](gateway_lifecycle.md)：启动、停止、健康状态和失败回滚。
- [Channel Adapter Boundary](channel_adapter_boundary.md)：平台 adapter 的输入输出边界。
- [Session Routing](session_routing.md)：平台身份、会话和控制命令。
- [Session Scheduler and Cancellation](session_scheduler_cancellation.md)：排队、并发、取消和 steering。
- [Emitter and Heartbeat Wake](emitter_heartbeat_wake.md)：统一出站与后台事件唤醒。
- [Desktop Event Loop](../../eventloop.md)：整个桌面产品的进程与关闭顺序。

## 事实来源

实现入口是 [Desktop Gateway](/apps/desktop/src/main/desktop-gateway.ts)、[Gateway orchestration](/apps/gateway/src/orchestration)、[Process Runtime port](/apps/gateway/src/orchestration/process-runtime.ts) 和 [Agent Runtime host](/apps/agent-cli/src/runtime-host.ts)。测试是失败语义和生命周期的可执行合同；文档与测试不一致时，以当前代码和测试为准。
