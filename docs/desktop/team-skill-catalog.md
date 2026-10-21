# 团队技能目录同步

LXE 技能页提供“团队技能目录”。指定一台工作站手动同步，公司同事在妙搭只读查看技能名称、说明、类型和来源；技能仍在各自的 LXE 中使用。

## 使用

1. 在妙搭创建全栈目录应用，并把运行时范围设为公司全员、需要登录。
2. 给发布机创建受限 API Key，只授权 `POST /openapi/lxe/catalog/sync`。
3. 在 LXE **能力 → 技能 → 同步设置**中填写完整 HTTPS 接收地址、来源设备名称和 API Key。地址需包含应用的路径前缀，例如 `https://<应用域名>/app/<app_id>/openapi/lxe/catalog/sync`。
4. 保存后点击 **同步到妙搭**。看到“最近同步 N 项”才表示云端确认成功；同事在网页点击“刷新目录”看到更新。

这是手动发布的目录，不会随本地文件变动自动更新。每次同步完整替换这台机器的上一次目录，也会移除本机已停用、删除或无权限的技能。空目录会清空云端列表。换发布机需要管理员重新安排绑定，不能靠更改设备名称冒充原机器。

## 数据边界

Electron 每次通过既有 JSON-RPC `dashboard_call` 的 `skills.list` 查询 agentcli。该结果已经应用当前权限、启用状态和名称解析规则。`lxeskill list` 查询的是业务命令，不能代替技能目录接口；也不直接读取 lxeskillCLI 的 `catalog.json`。

Electron 只投影 `name`、`description`、`type`、`source` 四个字段。不上传 SKILL.md 正文、参考文件、脚本、文件路径、执行记录或凭据。妙搭保存的是明确发布给团队的浏览快照，不作为 LXE 运行时或授权状态的来源。

接收地址、发布机 UUID、递增序号、API Key 和最后成功回执统一保存到数据目录 `config/team-catalog.bin`，由 Electron `safeStorage` 加密。Renderer 不读取已保存的 Key；修改接收地址必须重新填写 Key。系统安全存储不可用时拒绝保存或同步。

## HTTP 契约

公开类型在 `packages/foundation/desktop-protocol/src/team-catalog.ts`。请求使用 `Authorization: Bearer <API_KEY>`，不跟随重定向；最大 900 KB、2000 项，超时 30 秒。字段为 `schemaVersion`、`sourceId`、`sourceLabel`、`revision`、`collectedAt` 和 `skills`。

云端首次写入绑定 `sourceId`，随后只接受同一来源、更大的 `revision`，通过单条条件 upsert 原子替换快照。回执必须包含匹配的 `sourceId`、`revision`、`skillCount` 和有效 `receivedAt`。同步失败时保留上一次成功回执；HTTP 错误会保留真实响应并脱敏、截断。响应丢失时再次手动同步会使用更大的序号。

飞书页面只提供需要登录的读取接口。数据库 RLS 允许登录成员读取、拒绝普通成员写入和匿名访问；同步 OpenAPI 的受限 Key 在平台网关验证后以系统身份写入。
