# Agent 统计上传

agentcli 的 `TurnUsageSyncService` 使用 Agent Store 和同步配置独立上传统计，不依赖 lxeskillCLI 是否安装、CLI 启动检查或 Skill 授权。统计采集与导出由 [statistics](../../../packages/agent/runtime/src/statistics/) 和 [usage-store.ts](../../../packages/agent/runtime/src/state/usage-store.ts)负责，上传服务只管理批次、确认和重试。

## 启用与数据范围

上传读取 `LXE_DATA_SERVER_ENABLED` 和 `LXE_DATA_SERVER_URL`。Electron 仅在本目录已有受管接入配置、服务器地址有效且未切换绑定时注入启用值；仅自动发现设备的新目录不会启用上传。接入与凭据关系见 [桌面云端接入](../../desktop/cloud-access.md)。

服务器按 WireGuard 来源设备鉴权。客户端通过原生 HTTP 携带 `X-LXE-Client: cli`，不发送 Authorization／Cookie，不走系统代理或重定向，不依赖旧业务 Token。

新回合上传回合和模型用量，明细为 `tool` 和 `skill_use`。每个回合中，每个用过的 Skill 上传一项，字段为 `kind`、`name`、`module` 和 `calls`（固定为 1）。显式或隐式来源只保存在本地。工具项还上传 `errors` 和 `duration_ms`。升级前记录、还没上传的回合没有 `skill_use`，这些回合照旧上传读取和命令调用记录；服务端按同一口径每回合每个 Skill 计一次，所以升级不会丢数据，也不会重复计数。lxeskillCLI 从自己的数据库单独上传业务命令调用。Skill 目录的使用判定见 [Skill 使用与本地调用统计](../skill/README.md#skill-使用与本地调用统计)。

## 调度、确认与失败恢复

启用后首次延迟五分钟，之后每小时执行；积压批次另行调度，同一轮上传合并执行。关闭运行时时清理定时器、取消在途请求，并等待正在结束的任务。

进度按服务器地址保存。首次建立进度时选择最近一年记录，已经进入待上传范围的记录不因跨过一年而跳过。服务器按批次记录去重；客户端只有收到完整有效的 ACK，且数量和末尾序号均与本批一致时，才推进进度。ACK 超过 1 MiB 或格式不合法均报错，不能当作成功；具体批量上限以 [上传服务](../../../packages/agent/runtime/src/operations/turn-usage-sync.ts)为准。

HTTP 409 归属冲突、401／403、网络失败或无效 ACK 都保留本地数据、进度与实际诊断。失败按 30、60、120、240 秒、最多 5 分钟退避，成功后重置。管理员修复服务器归属后，下次有效确认即可恢复，无需重建实例 ID 或清空统计。

旧备用服务器配置已移除，读取旧配置时剔除废弃字段，不合并旧地址进度。`machine_id` 用于统计归属，不能替代服务器对来源设备的鉴权，也不能通过新建 ID 绕过归属冲突。

## 维护与验证

服务端需先支持对应上传契约。历史实例归属修复见遥测服务器仓库的 `docs/native-statistics-upload.md`；旧客户端兼容由服务端维护。独立飞书网关的配置和发布属于该网关仓库，本手册只描述当前 agentcli。

实现见 [turn-usage-sync.ts](../../../packages/agent/runtime/src/operations/turn-usage-sync.ts)和 [cloud-http.ts](../../../packages/agent/runtime/src/tooling/cloud-http.ts)；定向验证入口为 [上传服务测试](../../../packages/agent/runtime/test/operations/turn-usage-sync.test.ts)。

历史结果见 [2026-09-21 迁移验收](../../acceptance/native-statistics-acceptance-2026-09-21.md)和 [2026-09-22 恢复行为验收](../../acceptance/cloud-migrations-20260922.md#统计上传失败恢复)。
