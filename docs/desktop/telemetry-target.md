# 新版设备识别与遥测

桌面端启动时不通过旧 Enrollment 的 `cloud.managed` 开启遥测。成功读取 `/api/v1/device-context` 后，Electron 将已观察到的设备身份和服务地址通过 JSON-RPC `update_telemetry_target` 交给 agentcli；`initialize.telemetry_target` 使用同一结构。

目标为 `{enabled: false}`，或 `{enabled: true, server_url, device: {kind, id}}`。`kind` 支持普通设备和管理员设备。身份仅用于本地切换检查，服务端仍根据真实 WireGuard 来源决定设备及上传实例归属。ERP 免密资格、ERP 操作权限和云端模型是否配置均不决定遥测开关。

第一次识别成功即调度同步；启动后才连接 VPN 同样生效，不重启 Agent、不终止正在执行的任务。重复目标不会增加定时器。临时断网继续本地记录并沿用失败退避；明确拒绝或身份不匹配暂停上传，数据和 ACK 保留，后续验证成功恢复。

设备身份变化沿用现有确认流程，服务端拒绝跨设备冒领实例。切换或停用会取消在途请求，旧目标迟到的成功回执不会推进本地 ACK。409 保留实际错误并重试，不生成新 machine_id 绕过冲突。首次启用后沿用现有每小时周期、批次限制及最多五分钟失败退避。

统计、SQLite、machine_id 和上传进度由 agentcli 维护；Electron 不读取其数据库。独立运行的 agentcli 仍兼容显式环境配置；由桌面启动时以协议提供的目标为准，不从缓存身份或旧 Enrollment 自动启用。

关联服务端 PR 独立修复历史登记误判和 ERP 网页访问策略。先发布服务端可恢复已有上传客户端；桌面发布后补齐未导入旧登记配置设备的自动上报。开发交付为 PR，生产部署和客户端发布另行安排。
