# 会话模型与 effort

每个会话独立记录 provider、model、凭证来源（local/cloud）、effort 和 thinking 开关。切换会话或重启应用后，输入框恢复这个会话的选择。修改立即保存，但正在执行的一轮继续使用启动时的配置，下一轮才采用新选择。

## 状态存在哪里

状态由 Runtime 管理，沿用 Transcript v2。下列磁盘路径均相对于 [数据目录](../../desktop/data-location.md)；模型定义、凭据来源与请求适配见 [模型目录](../llm/provider_catalog.md)。

| 层 | 保存内容 | 用途 |
| --- | --- | --- |
| `db/session_transcripts/<session>.jsonl` | `model_selection`：用户选择及版本；`turn_context`：本轮实际使用的配置及选择版本 | 权威记录，能恢复未发送消息的选择 |
| `db/agent.sqlite3` 的 `agent_sessions` | `pending_model_selection`、`model_selection_version`，以及已有的 `model`、`reasoning_effort`、`model_config` | 可重建的读取投影 |
| 桌面全局模型偏好 | 最近一次选择 | 新会话的默认值 |
| Dashboard 查询缓存 | 按 `session_id` 分开的模型结果 | 界面显示和保存中的临时反馈 |

选择记录只含模型身份和选项，不保存 API Key。凭证仍从现有配置读取。

读取顺序是：**尚未用于一轮的选择 → 最近一轮实际使用的配置 → 全局默认值**。旧会话可直接从已有 `turn_context` 恢复，无需批量改写历史。既未选择模型、也没有执行历史的空白会话使用当前全局默认值。

## 保存与生效

Dashboard 的 `models.current`、`models.update`、`models.thinking.update` 携带 `session_id`；写入还携带所读的 `selection_version`。省略会话 ID 时，保留原来的全局默认配置接口。

Runtime 在会话写队列里检查版本、追加 `model_selection`、同步文件到磁盘，再更新 SQLite 投影并返回成功。如果进程在日志写入后、投影更新前退出，下次读取会补齐投影。

每轮开始时，Runtime 一次性取得会话选择和版本，创建本轮独立的 provider 快照。工具循环、重试及上下文压缩都使用这个快照。`turn_context` 只能消耗同版本的待用选择：运行期间再次切换，即使选回相同模型，也有更高版本，旧轮次不能将其覆盖。

前端按会话缓存和回滚；A 会话保存期间切到 B，A 的成功或失败响应只更新 A。低版本的迟到查询结果不会覆盖已确认的新版本。

更新会话后，会尝试同步全局默认值供新会话使用。默认值保存失败会记录真实错误，但不撤销已经保存的会话选择。已保存的模型失效或被移除时，界面仍显示原模型和 effort，执行时返回配置错误，用户可重新选择。

定时任务初始化新会话时，两种写接口都带 `remember_default: false`：只写目标会话，不修改全局环境、偏好文件或默认 Provider 快照。此选项必须与 `session_id` 一起使用；交互式模型切换不传此选项，继续记住最近一次用户选择。后台任务的固定模型或 effort 因此不会改变后续默认任务／新会话的配置。

## 验证入口

- `packages/agent/runtime/test/state/model-selection.test.ts`：独立保存、重启、投影重建、旧轮次与并发写入。
- `packages/agent/runtime/test/engine/session-model.test.ts`：一轮多次模型请求固定配置，下一轮采用新选择。
- `apps/agent-cli/test/session-models.test.ts`：会话接口、旧版本拒绝、不可用模型。
- `apps/dashboard/test/behavior/app-actions.cjs`：真实界面的跨会话保存、失败回滚和重新加载。
