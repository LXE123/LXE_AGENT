# Session Routing And Permission

状态：Current

## 目的

这篇文档解释一条平台消息在进入 agent runtime 之前，如何被识别身份、检查权限、绑定 session，并变成可调度的 `AgentJob`。读者如果在排查“为什么没进 agent”“为什么进了旧会话”“为什么 `/stop` 或 `/clear` 没按预期工作”，应该读这一篇。

## 设计理念

路由权限层把平台身份、用户权限、session 生命周期和 agent job 创建放在同一个门口处理。它负责决定“这条消息能不能进入 runtime，以及应该进入哪个 session”，但不负责 LLM 上下文、tool 执行或最终回复格式。

## 链路位置

这一层位于 `ChannelRegistry`/dispatch loop 之后、`SessionScheduler` 之前。它接收 `InboundEvent`，创建或复用 session，保存 response route，然后把普通消息变成 `AgentJob(job_kind="turn")`；控制命令则在这里直接处理，不进入 agent loop。

本文维护 gateway 的入站路由、权限和 session 绑定。事实来源是 [gateway/session_router.py](../../../gateway/session_router.py)、[shared/session_bindings.py](../../../shared/session_bindings.py)、[shared/permission_policy.py](../../../shared/permission_policy.py)、[shared/permission_policy_loader.py](../../../shared/permission_policy_loader.py) 和 [config/permission_policy.yaml](../../../config/permission_policy.yaml)。

## Route entry

`SessionRouter.route_message(event)` 是入站消息进入 agent runtime 前的 gateway 主路由：

1. 从 `InboundEvent.source` 构造 `SessionSource`。
2. 生成 `session_key`。
3. 构造 `SessionContext`。
4. 解析权限 user id 和 bot id。
5. 检查 bot 是否已知、用户是否允许访问该 bot。
6. 识别 `/stop` 和 `/clear` 控制命令。
7. 普通消息加载或创建绑定 session。
8. 读取并清空该 session 的 pending events。
9. 创建 `AgentJob(job_kind="turn")`。
10. enqueue 到 `SessionScheduler`。

`RouteDecision` 只记录路由结果类型、lane key 和平台，方便上层观测。

## SessionSource 和 session_key

`SessionSource` 是平台来源的规范化形态。当前关键字段包括：

- `platform`
- `chat_id`
- `chat_type`
- `user_id`
- `user_id_alt`
- `user_name`
- `thread_id`
- `message_id`
- `root_id`
- `parent_id`
- `extra`

`session_key` 当前规则：

- DM：`agent:main:<platform>:dm:<chat_id>`
- 群聊有 thread：`agent:main:<platform>:group:<chat_id>:<thread_id>`
- 群聊无 thread：`agent:main:<platform>:group:<chat_id>:<user_key>`
- 其它 chat type：`agent:main:<platform>:<chat_type>:<chat_id>`

`user_key` 优先使用 `user_id_alt`，否则使用 `user_id`。Feishu 场景下 `user_id_alt` 通常是 union id。

## 权限策略

当前权限事实来源是 [config/permission_policy.yaml](../../../config/permission_policy.yaml)，由 `shared.permission_policy_loader` 加载并校验。

YAML 中每个 bot 配置：

- `key`：内部权限 key。
- `app_id`：平台 bot app id。
- `skill_types`：该 bot 可见的 skill type，支持 `*`。

YAML 中每个 user 配置：

- `union_id`：权限判断使用的用户 id。
- `allow`：允许访问的 bot alias，或 `*`。

`SessionRouter` 调用：

- `resolve_bot_id(event)`：优先从 raw data 和 extra 取 bot id；Feishu 可回退到 `FEISHU_APP_ID`。
- `is_known_bot_id(bot_id)`：bot app id 必须存在于 policy。
- `can_user_access_bot(union_id, bot_id)`：用户必须允许访问该 bot key 或 `*`。

如果 bot 未知或用户无权限，router 会通过当前平台 adapter 发送权限反馈，不会创建 agent job。

## Bot skill visibility

Gateway 只做 bot/user 权限和 session 路由。真正的 skill 加载在 agent runtime 内完成，但 bot 可见 skill type 来自同一份 policy：

- `AMAZON_FBA`：`amazon_fba` + `default`
- 备货 bot：`amazon_replenish` + `default`
- `LXE_CLAW`：`*`

当前 skill catalog 见 [Skill docs and catalog](../skill/README.md)。

## 控制命令

`/stop` 和 `/clear` 会在创建普通 turn job 之前处理。中文全角斜杠 `／` 会被归一化为 `/`。

`/stop`：

- 如果当前 `session_key` 没有绑定 session，回复“当前没有正在执行的回复。”
- 如果存在 session，则调用 `SessionScheduler.request_stop(session_id)`。
- 只有 active run 存在时才会真正触发取消。

`/clear`：

- 如果旧 session 仍有 active 或 pending work，拒绝创建新会话。
- 否则通过 `SessionBindingStore.rotate()` 为同一 `session_key` 绑定新的 `session_id`。
- 创建新 `agent_sessions` 记录，并回复“已创建新会话。”

## Session binding 和 response route

`SessionBindingStore` 默认把绑定写到 SQLite 同目录的 `sessions.json`，可通过 `AGENT_SESSION_BINDINGS_PATH` 覆盖。

绑定关系是：

- `session_key` -> `session_id`

`SessionRouter` 在创建、复用或发送控制反馈前都会调用 `create_response_route_context(ctx)`，把 `response_route_id` 对应的平台 route 存进 SQLite。后续 `GatewayEmitter` 和 adapter 使用它把回复发回正确平台位置。

## AgentJob

普通消息创建 `AgentJob(job_kind="turn")`，核心字段来自 `SessionContext`：

- `job_id`：新 uuid。
- `session_id`、`session_key`
- `response_route_id`
- `user_id`、`conversation_id`、`is_group`
- `message_id`
- `user_input`
- `sender_nick`
- `source`
- `user_content_blocks`

如果 session 有 pending events，router 会通过 `pop_agent_session_pending_events(session_id)` 取出并放入 `raw_data.system_events`。这些事件随下一次 turn 一起进入 agent runtime。
