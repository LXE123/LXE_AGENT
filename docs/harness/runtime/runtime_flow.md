# Runtime Flow

状态：Current

## 主链路

```text
Bun CLI
  -> ProductionGatewayApplication
  -> FeishuAdapter
  -> InboundEvent
  -> SessionRouter
  -> AgentJob
  -> SessionScheduler
  -> TypeScriptAgentRuntime.runTurn()
  -> RuntimeProvider / ToolRegistry
  -> TurnOutcome
  -> GatewayEmitter
  -> Feishu CardKit / media
```

Gateway 与 Runtime 是同一 Bun 进程内的直接函数调用。`RunHandle` 同时承载 `AbortSignal`、steering queue 和活跃进程登记；同 session 串行、跨 session 并发由 `SessionScheduler` 保证。

## 边界地图

| 边界 | 当前实现 |
| --- | --- |
| Bootstrap/lifecycle | [`apps/gateway/src/main.ts`](/apps/gateway/src/main.ts)、[`production.ts`](/apps/gateway/src/production.ts)、[`gateway-lifecycle.ts`](/apps/gateway/src/gateway-lifecycle.ts) |
| Inbound | [`apps/gateway/src/feishu/inbound.ts`](/apps/gateway/src/feishu/inbound.ts) |
| Routing/scheduling | [`router.ts`](/apps/gateway/src/router.ts)、[`scheduler.ts`](/apps/gateway/src/scheduler.ts) |
| Turn execution | [`packages/runtime/src/runtime.ts`](/packages/runtime/src/runtime.ts) |
| Context | [`packages/runtime/src/context.ts`](/packages/runtime/src/context.ts) |
| Provider | [`packages/runtime/src/provider.ts`](/packages/runtime/src/provider.ts) |
| Tools/MCP/skills | [`tools.ts`](/packages/runtime/src/tools.ts)、[`mcp.ts`](/packages/runtime/src/mcp.ts)、[`skills.ts`](/packages/runtime/src/skills.ts) |
| Storage | [`packages/runtime/src/storage.ts`](/packages/runtime/src/storage.ts) |
| Outbound | [`apps/gateway/src/emitter.ts`](/apps/gateway/src/emitter.ts)、[`apps/gateway/src/feishu/cardkit.ts`](/apps/gateway/src/feishu/cardkit.ts) |

## 持久化

- SQLite 保存 session、response route、pending event 和 usage。
- `session_transcripts/*.jsonl` 是 append-only transcript；replacement/compaction checkpoint 不重写旧事件。
- `sessions.json` 保存稳定的 session binding。
- transcript replay cache 以 size/mtime 失效；base64 图片只在当前 turn 内存存在，落盘时替换为占位。

## Python 边界

浏览器、Amazon、马帮和 Excel 业务能力通过 [`py_tools/catalog.json`](/py_tools/catalog.json) 与单请求 JSON bridge 调用。stdout 只允许一个协议响应，日志走 stderr；TS 负责 timeout、输出限制、取消、Windows 进程树终止和文件投递。它们不是常驻 runtime，也不能由 active skill 通过 coding `exec` 绕过。
