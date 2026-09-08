# 会话圆点

圆点表示整轮任务状态，选中会话只用背景高亮。运行与停止时呼吸，排队时空心；空闲后，未查看的失败显示红点，成功显示绿点。取消不产生完成提示。系统要求减少动画时停用呼吸。

## 谁决定开始与结束

Scheduler 接受任务后发布 queued，分配执行位置后发布 running；取消请求期间是 stopping，被拒后恢复 running。Runtime 返回或抛错，由 Gateway 转为 runtime.turn.completed，Scheduler 核对 session/run/job 身份后才发布终态。流结束、工具失败、后台命令仍存活都不能单独决定整轮结束。自动唤起也走同一调度入口。

SessionStatusCoordinator 合并同一次调度推进中的变化，避免上一轮完成、下一轮开始之间闪绿。持久化请求返回时还会核对当前执行者，避免慢写入带来过期的空闲状态。每次 Gateway 实例有独立 epoch，事件与对外快照有递增版本；Renderer 拒绝旧快照及旧实例的迟到事件。

## 存储与已读

内部 `session_status` RPC 交给 Runtime 写入 `db/agent.sqlite3`。`agent_session_runs` 按 session_id + turn_id 记录生命周期及精确已读回执；`agent_session_status_versions` 保存会话摘要版本和已读位置。新安装只记录新任务，不扫描旧回答生成未读。删除会话时在同一事务清理记录。

Renderer 先订阅变更，再按当前列表批量调用 `sessions.status.list`，每批最多 200 个会话。摘要不含正文或工具输出。列表翻页、搜索、重新连接和窗口重新获得焦点时补取快照。

只有聊天页面可见、窗口有焦点、对应终态结果已加载或已展示为终态实时回答，才调用 `sessions.status.ack`。确认必须携带实际展示的 turn_id 和结果版本，不会覆盖后来到达的新结果，也不会把另一轮未查看的失败一起清除。已读变更广播到所有窗口。

重新连接时用 Scheduler 的真实执行者校准 SQLite。没有执行者的非终态记录变成“上次运行结果未确认”，不会伪装成功或一直呼吸。断连显示“状态暂不可用”。写入失败记录并显示实际错误，保留待写事件重试，Agent 执行不等待摘要写入。

## 验证

定向测试从仓库根运行：

```sh
bun test packages/agent/runtime/test/state/session-status.test.ts apps/gateway/test/orchestration/session-status.test.ts apps/gateway/test/orchestration/composition.test.ts apps/dashboard/test/features/sessions/session-status.test.ts apps/desktop/test/preload-bridge.test.ts apps/agent-cli/test/json-rpc-server.test.ts
bun run typecheck
```

真实窗口 fixture 使用生产会话列表、聊天展示控制器、状态 hook、Coordinator 和临时 SQLite；只有模型输出与桌面订阅 transport 是 fixture。每次验收先启动一个新的 fixture server：

```sh
bun apps/dashboard/test/features/sessions/session-status-fixture-server.ts
# 在另一个终端，用本机 Electron 可执行文件运行：
apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/test/fixtures/session-status.electron.cjs
```

脚本检查两窗口前后台、栏目切换、结果晚加载、已读广播、断连重连、SQLite 关闭重开、窗口重载、遗留任务、深浅主题和减少动画。主题截图输出到系统临时目录。完成后 Ctrl+C 停止 fixture server 并删除临时数据库。此 fixture 不连接模型、渠道或用户数据。
