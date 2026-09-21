# 业务流程通过设备访问云服务器

FBA 的 ERP 协作流程和备货 SKU 核验均通过公共云端模块访问本服务器。保持 WireGuard 在线并设置 `LXE_DATA_SERVER_URL` 即可提供云端连接信息，不需要桌面应用启动、业务 Token 或先运行 `cloud-status`。正常业务文件、参数及直接访问马帮网站所需的浏览器会话仍按原流程准备。

已接入的 ERP 流程包括采购预览与导入、采购文件重建、合同下载、装箱预览与确认、对账详情、报关预览。备货接入店铺、Listing 关联、库存 SKU 和组合 SKU 查询。命令及参数不变，服务端逐次检查设备及当前权限：ERP 需要 `erp`，采购和装箱还需原动作权限；马帮查询需要 `mabang_read`。

## 通信与错误

同步流程使用 `shared.infra.cloud_client.CloudClient`，异步 SKU 查询使用 `shared.infra.cloud_async.AsyncCloudClient` 的异步上下文管理器。两者均不发送 Authorization 或 Cookie，不使用系统代理，不跟随重定向、不回退旧 Key。

ERP 超时为 30 秒，不自动重试；SKU 超时为 60 秒，沿用最多 3 次的临时故障重试，认证拒绝与业务失败不重试。采购/装箱的 409 确认响应及幂等标识保留，由业务代码决定下一步。

业务显式使用 `max_response_bytes=None` 读取完整响应；自检仍限 1 MiB。响应包含解析结果、HTTP 状态、耗时、原始 `content` 和必要响应头（Content-Type、Content-Disposition、Retry-After）；`request_bytes` 用于文件下载。对外诊断继续脱敏并明确截断，不把被截断的响应当作完整业务数据使用。

## 发布与验收

先部署支持 8 个原生 ERP 操作的服务器，再更新 CLI。旧客户端的 Token、ERP 网页和管理员会话仍可使用。本轮未清理桌面凭据管理、赛狐 MCP 或统计上传。

写入及确认流程在隔离测试库验收，线上只读取。马帮上游应用过期必须显示实际错误，真实 SKU 查询验收等待上游恢复。需要回滚服务器时先回滚新 CLI，不能添加隐式凭据回退。
