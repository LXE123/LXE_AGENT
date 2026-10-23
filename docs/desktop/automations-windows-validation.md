# 定时任务的 Windows 实机验证

2026-10-23，在 Windows 10 Pro x64（19045）通过 SSH 验证，基线为 PR #115 合并提交 `609bc91f`。使用独立任务 worktree、临时数据和模拟模型执行，没有连接真实业务账号。

环境：Bun 1.4.2、Node 24.14.0、Electron 43.7.0。调度规则沿用同一份 TypeScript 实现，平台重点是本机管道、子进程、文件句柄和 Electron 控件行为。

## 已验证

| 检查 | 结果与边界 |
| --- | --- |
| 15 个文件的定向回归 | 118 个测试通过，覆盖 100 个同时间任务分批启动、两种会话模式、忙碌与编辑延后、取消竞争、时区与 DST、状态持久化和历史回合定位。 |
| 桌面 MCP | 真实 Runtime → MCP STDIO 子进程 → Windows 命名管道 → 持久化计划；新版协议协商、调用身份隔离、错误凭据、取消、关闭和禁用通过。模型回复为 fixture。 |
| Node bundle | MCP 和时间 Worker 打包后在临时目录运行，独立于 workspace 依赖；超时后 Worker 可重建。 |
| Electron 主进程 | 使用 Electron 自带 `node:sqlite`，退出前留下已提交但未确认的派发记录；新进程恢复后标为待确认，不自动重发。定义、会话/回合 ID 和偏移盐保持不变。 |
| 文件与 Worker 生命周期 | 数据目录含中文和空格，bundle 路径含空格；复杂 RRULE 超时期间主线程继续响应，之后仍可计算。关闭后在同一 Electron 进程中立即删除数据库目录，确认不是依赖进程退出释放句柄。 |
| Renderer 行为 | 会话历史窗口、Dashboard 页面、弹窗、就绪状态、Windows 标题栏与菜单，6 个场景测试通过。 |
| CDS | 亮暗主题共 24 组检查、84 项状态测量、12 张截图，包含键盘、悬停/焦点/错误/禁用、窄屏。见 [Windows 报告](../design/cds/showcase/automations/windows/verification.json)。 |
| 构建 | Windows `bun run typecheck`、`bun run desktop:build`、`bun run agent-cli:build` 均通过。这是源码构建，不是安装包验收。 |

macOS 同时回归了修改的 SQLite / MCP 测试、新增 Electron 测试、历史定位测试、类型检查、生产边界检查和 CDS 验收。

## 实机发现并修复的测试问题

- CDS 脚本把输出目录放在 URL 参数后，Windows Electron 立即退出（255）。调整为 URL 最后，并按平台保存验收证据。
- 两个测试用 Bun SQLite 模拟生产 Node SQLite。Bun 默认 `close()` 会等未释放的 prepared statement 收集后才释放连接，Windows 删除临时目录时报 `EBUSY`。实机最小复现确认：Bun `close(true)` 与 Node `close()` 均能立即删除文件；测试因此使用严格关闭，不修改生产存储逻辑。
- 历史定位测试准备 40 条持久消息的一轮运行超过默认 5 秒（约 7.1 秒）。该集成测试上限调整到 30 秒，断言保持不变；最终整组回归通过。该上限不是生产性能承诺，也不改变调度或 Worker 超时。

## 重复运行

在仓库根目录同步锁定依赖后执行；Electron 测试需要桌面运行环境：

```sh
bun test apps/gateway/test/orchestration/automations.test.ts apps/gateway/test/orchestration/automation-clock.test.ts apps/gateway/test/orchestration/scheduler.test.ts apps/gateway/test/orchestration/local-conversation.test.ts apps/gateway/test/orchestration/process-runtime.test.ts apps/desktop/test/automation-store.test.ts apps/desktop/test/automation-electron.test.ts apps/desktop/test/automation-clock-bundle.test.ts apps/desktop/test/desktop-mcp.test.ts apps/desktop/test/desktop-mcp-bundle.test.ts apps/agent-cli/test/desktop-mcp.test.ts packages/foundation/desktop-protocol/test/automations.test.ts packages/agent/runtime/test/state/dashboard-storage.test.ts apps/dashboard/test/features/automations/form.test.ts apps/dashboard/test/features/sessions/display-controller.test.ts
bun test apps/dashboard/test/behavior/renderer.test.ts --test-name-pattern 'conversation-window|dashboard-pages|dialog|readiness|windows-titlebar|windows-menu'
bun run cds:check:automations
bun run typecheck
bun run desktop:build
bun run agent-cli:build
```

## 尚未覆盖

本轮没有让远程电脑整机休眠、重启或断网，没有验证托盘长时间驻留、安装/升级包和真实模型/业务任务。上述项目需要在可中断桌面使用的时间单独验收。尤其要检查：关闭窗口后计划仍可运行；真正退出后停止运行；睡眠恢复只合并一次逾期机会；重新登录后不会重复派发未确认执行。

页面检查使用隐藏 Electron 窗口加载生产页面和 CSS，不等同于操作已安装应用；截图也不覆盖所有系统原生弹出层、屏幕阅读器或触屏。
