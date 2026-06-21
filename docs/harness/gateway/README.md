# Gateway 文档入口

状态：Current

## 目的

这个目录回答一个问题：外部平台消息进入系统后，gateway 到底负责哪一段。读者如果正在排查 Feishu 入站、权限拦截、session 绑定、并发执行、取消或回复发送，应该先从这里建立整体地图，再进入具体专题文档。

## 设计理念

Gateway 的设计核心是把“平台接入”和“agent runtime 执行”隔开。平台 adapter 只把消息翻译成 gateway DTO，gateway 只负责路由、权限、调度和出站发送，真正的上下文构造、LLM step 和 tool 执行留给 agent runtime。这样平台 SDK、session 生命周期和模型执行不会互相缠在一起。

## 链路位置

Gateway 位于 `main.py -> GatewayApp -> SessionRouter -> SessionScheduler -> TurnHandler -> AgentLoop -> GatewayEmitter` 的前后两端：前半段接收平台消息并变成 `AgentJob`，后半段把 agent runtime 的 emit 请求送回平台。更完整的端到端 runtime 链路见 [Runtime Flow](../runtime/runtime_flow.md)。

本文是 `docs/harness/gateway/` 的当前入口。Gateway 文档只描述当前运行中的 gateway 层事实，不沿用已删除旧文档里的历史方案。

## 阅读顺序

1. [Gateway lifecycle](gateway_lifecycle.md)：启动、初始化、后台任务和优雅关闭。
2. [Channel and adapter boundary](channel_adapter_boundary.md)：平台 adapter 与 gateway 的入站/出站边界。
3. [Session routing and permission](session_routing_permission.md)：权限、session 绑定、控制命令和 `AgentJob` 创建。
4. [Session scheduler and cancellation](session_scheduler_cancellation.md)：同 session 串行、全局并发和取消句柄。
5. [Emitter and heartbeat wake](emitter_heartbeat_wake.md)：出站发送、typing、文件、stream 和后台唤醒。

## 事实来源

- [main.py](../../../main.py)
- [gateway/](../../../gateway)
- [shared/platform/adapter.py](../../../shared/platform/adapter.py)
- [shared/permission_policy.py](../../../shared/permission_policy.py)
- [shared/permission_policy_loader.py](../../../shared/permission_policy_loader.py)
- [config/permission_policy.yaml](../../../config/permission_policy.yaml)

## 当前模块划分

Gateway 按运行职责划分，而不是按平台或业务 skill 划分：

- 生命周期层：`main.py` 和 `GatewayApp` 负责启动、关闭和组装依赖。
- 平台边界层：adapter 把平台事件转成 `InboundEvent`，把 `OutboundRequest` 发回平台。
- 路由权限层：`SessionRouter` 解析来源、权限、控制命令和 session 绑定。
- 调度执行层：`SessionScheduler` 控制 session 串行执行、全局并发和取消。
- 出站唤醒层：`GatewayEmitter` 发送回复，`HeartbeatWakeManager` 把后台 pending event 重新送回 scheduler。
