# Session Routing and Permission

状态：Current

## 目的

Session Router 是平台事件进入调度器前的控制面。它验证 bot/user 权限，解析稳定 session source，维护 binding 与 response route，处理 `/stop`、`/clear` 和 steering，最后创建字段完整的 `AgentJob`。

## 事实来源

- [`router.ts`](/apps/gateway/src/orchestration/router.ts)：消息路由和控制命令。
- [`permission-policy.ts`](/apps/gateway/src/security/permission-policy.ts)：bot alias、permission key 与用户授权。
- [`session-bindings.ts`](/apps/gateway/src/state/session-bindings.ts)：稳定 source-to-session 映射。
- [`session-state.ts`](/apps/gateway/src/state/session-state.ts)：进程内 autonomy/steering 状态。

## 权限模型

Permission policy 把多个 bot app id 映射到 permission key，再由 key 决定允许的 user 与 skill types。共享 key 的 bot 必须拥有完全一致的 skill policy，避免同一权限名在不同机器产生不同能力。

Router 在访问 session store 或 scheduler 之前先验证：

1. bot app id 能解析为已知 permission key。
2. user union/open id 在该 key 的允许集合中，或 policy 明确允许 wildcard。
3. source 中用于构造 session key 的字段完整。

拒绝结果只返回用户可读反馈，不创建 session、response route 或 pending job。

## Session source 与 binding

`SessionSource` 归一化平台、bot、用户、chat type、chat id、thread 和显示名。稳定 session key 由平台身份和会话边界组成：私聊按用户隔离，群聊按 chat/thread 与用户规则隔离。

`SessionBindingStore` 使用原子 UTF-8 JSON 保存 source key 到 session id 的映射：

- 已有 binding 且 SQLite session 存在时复用并 rebind 最新 source。
- binding 存在但 session 丢失时创建新的 session，避免悬空引用。
- `/clear` 在无 active work 时旋转到新 session。
- 无效根结构或重复/残缺 entry 不会被默默接受。

binding 文件默认与 SQLite 位于同一 `user_session_db` 目录，也可由 `AGENT_SESSION_BINDINGS_PATH` 覆盖。

## Response route

每条可回复入站事件都会保存独立 `response_route_id`。route 包含 platform、source message、conversation、thread、sender 和平台 delivery handle 等信息，使 Runtime 只需要携带 route id。

Router 在 enqueue 前 upsert route；CardKit 创建后可 patch `platform_message_id` 或其它 delivery metadata。Emitter 必须重新读取 route，不能依赖过期内存对象。route delivery 失败只影响该次发送，不回滚已经完成的 turn 或其它 route。

## 普通消息路由

通过权限和 source 校验后，Router：

1. ensure/rebind session。
2. 恢复 autonomy suspension。
3. 保存 response route。
4. pop 已持久化的 pending events，并附加到本轮输入上下文。
5. 把文本、附件 blocks、source 和 raw metadata 组装成 `AgentJob`。
6. 交给 `SessionScheduler.enqueue()`。

用户消息不直接调用 Runtime。即使当前没有并发压力，也必须经过 scheduler，以保持 stop、steering 和 heartbeat 语义一致。

## 控制命令

### `/stop`

停止命令清除该 session 的 pending queue，取消 active run，并设置 autonomy suspended。被中断 run 的用户停止事件先持久化，等下一条用户消息再汇报；heartbeat 在 suspended 状态下丢弃自主唤醒。

### `/clear`

存在 active 或 queued work 时拒绝 clear，避免把进行中的结果写入错误 session。空闲时创建新 session binding，并保留旧 transcript 作为历史记录。

### Steering

steering 是 session 级开关。启用时，纯文本消息优先注入 active run；附件仍作为普通 job 排队。若 run 已进入 closing 或不存在，消息回退到队首，不能丢失。

## Skill 与 connector 权限

Bot 的 allowed skill types 和本地 connector enabled state 共同影响：

- Runtime system prompt 中可见 skill。
- skill activation 后可暴露的 owner script tools。
- Dashboard skill catalog 与 connector 控件。

这些变化从下一 turn 生效；正在运行的 turn 使用启动时固定的 exposure snapshot。

## 失败语义

Router 对单条坏消息返回明确 feedback，不终止 adapter ingress。保存 pending event 或 feedback 失败时仍继续执行 stop/cancel 主动作。任何异常都必须保留 session 串行不变量，不能绕过 scheduler 直接重试 turn。
