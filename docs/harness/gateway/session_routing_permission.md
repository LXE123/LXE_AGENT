# Session Routing and Permission

状态：Current

事实来源：[`router.ts`](/apps/gateway/src/router.ts)、[`session-bindings.ts`](/apps/gateway/src/session-bindings.ts)、[`permission-policy.ts`](/apps/gateway/src/permission-policy.ts)。

Router 验证 bot/user policy，把 `conversation + user + bot` 映射到稳定 session binding，保存 response route，并将 `InboundEvent` 转为 `AgentJob`。`/stop`、`/clear` 和 steering 在这里进入 scheduler 控制面。

Bot 的 allowed skill types 与 connector enabled state 会同时过滤 Runtime prompt、owner script tool exposure 和 Dashboard skill catalog；变化从下一 turn 生效。
