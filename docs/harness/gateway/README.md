# Gateway

状态：Current

## 目的

Gateway 是 LXE Agent 的进程边界、平台边界和调度入口。它负责把飞书事件转换成稳定的 `InboundEvent`，完成权限、session binding、排队与取消，再把 turn 交给同一 Bun 进程中的 `TypeScriptAgentRuntime`。Runtime 产生的 stream、tool、final 和 typing 事件统一由 Gateway 发送回原平台。

本文目录用于回答这些问题：

- 生产进程由哪些组件组成，按什么顺序启动和停止。
- 平台 adapter 可以做什么，不能越过哪些边界。
- 用户、bot、会话和 response route 如何关联。
- 同 session 串行、跨 session 并发、`/stop` 和 steering 如何协作。
- 后台任务结束后，为什么仍通过正常 session 调度回到用户。

## 当前拓扑

```text
Bun CLI
  -> ProductionGatewayApplication
  -> GatewayLifecycle
  -> FeishuAdapter
  -> SessionRouter
  -> SessionScheduler
  -> TypeScriptAgentRuntime.runTurn()
  -> GatewayEmitter
  -> Feishu CardKit / message / file / typing
```

Gateway、Runtime、Dashboard、scheduler、channel adapter 和常驻维护任务运行在一个 Bun 进程中。生产路径没有 worker supervisor、NDJSON worker envelope 或其它 runtime fallback。Python 只存在于版本化的一次性业务脚本 bridge 后方，执行完成即退出。

## 专题导航

- [Gateway Lifecycle](gateway_lifecycle.md)：bootstrap、启动顺序、健康状态、停止和失败回滚。
- [Channel Adapter Boundary](channel_adapter_boundary.md)：统一 inbound/outbound 契约与飞书 SDK 隔离。
- [Session Routing and Permission](session_routing_permission.md)：权限、session binding、response route 和控制命令。
- [Session Scheduler and Cancellation](session_scheduler_cancellation.md)：排队、并发、cancel、steering 和 active run 生命周期。
- [Emitter and Heartbeat Wake](emitter_heartbeat_wake.md)：统一出站、CardKit stream 与后台事件唤醒。

## 事实来源

Gateway 的单一事实来源是 [`apps/gateway/src`](/apps/gateway/src)：

- `main.ts`、`cli.ts`：命令行入口、信号和状态文件。
- `production.ts`、`direct-composition.ts`：生产依赖装配。
- `gateway-lifecycle.ts`、`channel.ts`：组件生命周期。
- `router.ts`、`scheduler.ts`：入站控制面和 turn 调度。
- `emitter.ts`、`heartbeat-bridge.ts`：统一出站和后台唤醒。
- `feishu/`：飞书 SDK、消息转换、资源、CardKit 和 typing。

同目录测试是失败语义和边界行为的可执行合同。文档与实现不一致时，应先以源码和测试为准，再修正文档。

## 核心不变量

1. Adapter 不直接调用 Runtime，也不自行决定 session。
2. Router 在创建 `AgentJob` 前完成权限和 session source 校验。
3. Scheduler 保证同 session 只有一个 active run。
4. Runtime 只通过 emitter port 产生出站意图，不持有平台 SDK。
5. Emitter 必须通过 `response_route_id` 或 session source 解析目标平台。
6. 后台完成事件先持久化，再以 heartbeat job 进入同一个 scheduler。
7. 任何 adapter、turn 或维护任务失败都不能让未相关的 session 丢失状态。

## 非当前架构

历史 worker-based Gateway、跨进程 worker client 和旧平台实现不属于 Current 文档。生产入口只有 [`apps/gateway/src/main.ts`](/apps/gateway/src/main.ts)，production boundary check 会拒绝重新引入已删除的生产路径或 fallback。
