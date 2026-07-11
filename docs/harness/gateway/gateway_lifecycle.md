# Gateway Lifecycle

状态：Current

## 目的

当前生产拓扑是一个 Bun 进程：Gateway、TypeScript Runtime、Dashboard、scheduler、channels 和常驻维护任务都在同一进程内。Python 只会由 script bridge 按请求启动，完成后退出。

## 事实来源

- [`apps/gateway/src/main.ts`](/apps/gateway/src/main.ts)：CLI、顶层 fatal handler 和日志 flush。
- [`apps/gateway/src/cli.ts`](/apps/gateway/src/cli.ts)：`start`、`stop`、状态文件和配置读取。
- [`apps/gateway/src/production.ts`](/apps/gateway/src/production.ts)：生产组件装配。
- [`apps/gateway/src/direct-composition.ts`](/apps/gateway/src/direct-composition.ts)：单进程 Gateway/Runtime 组合。
- [`apps/gateway/src/gateway-lifecycle.ts`](/apps/gateway/src/gateway-lifecycle.ts)：启动、停止和失败回滚。

## 启动

开发环境使用：

```powershell
bun run gateway:dev
```

非 watch 的本地启动使用：

```powershell
bun run gateway:start
```

启动时依次完成 env/config、文件日志、SQLite/JSONL store、TypeScript Runtime、Dashboard、scheduler、channel 和 ingress 的初始化。Runtime 内部再启动 MCP manager、process manager 和维护任务；单个 MCP server 启动失败只记录该 server 的 error，不阻塞其它组件。

飞书 adapter 将平台事件转换成 `InboundEvent`，`SessionRouter` 创建 `AgentJob`，`SessionScheduler` 直接调用同进程 `TypeScriptAgentRuntime.runTurn()`。生产路径没有 worker supervisor、跨进程 NDJSON envelope 或其它 Runtime fallback。

## 停止

`SIGINT`、`SIGTERM`、CLI stop、fatal error 和 planned stop 最终都进入同一个生命周期控制器。关闭顺序保证：

1. 停止新 ingress 与 heartbeat wake。
2. 取消并等待 active turn，终止已注册的进程树。
3. 停止 scheduler 和 Runtime services。
4. 停止 channels 与 Dashboard。
5. 关闭 SQLite，并 flush/close Bun 文件日志。
6. 清理只属于当前 boot id 的状态文件。

每个步骤有有界等待；启动中途失败会逆序关闭已启动组件。验收要求连续 start/stop/restart 三轮后没有残留端口、SQLite lock、MCP、Python 或浏览器子进程。

## Dashboard

Dashboard API 和静态文件均由 `BunDashboardServer` 提供，默认监听 `127.0.0.1:8765`。模型/thinking PATCH 先创建并验证新的 provider client，再原子更新 `.env.local` 与 provider snapshot；变化只影响下一 turn。
