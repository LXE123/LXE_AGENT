# 赛狐 MCP 接入停用

产品暂时撤下 `lxe-saihu` 专用 MCP 接入，先整理通用 MCP 的配置、连接和工具管理边界。赛狐业务 CLI、业务数据、设备权限和其他公司服务不随之删除。

## 新配置与已有配置

[默认 MCP 配置](../config/mcp_servers.default.json)不再包含 `lxe-saihu`，现预置并启用通用 Streamable HTTP 服务 `team-skills`；桌面宿主注入的 `lxe_desktop` 保留。其他 stdio 和 Streamable HTTP 服务仍可通过用户配置接入。

赛狐 MCP 尚未被用户使用，本次直接删除专用实现与默认条目，不增加旧配置迁移。之前由默认模板生成的本地配置可能仍有关闭的 `lxe-saihu` 条目，可手动删除；启动时不会自动备份或改写用户配置。

## 通用连接器与后续接回

Runtime 不再按 `lxe-saihu` 名称选择网络实现或校验公司认证。手动重新启用旧条目会使用普通 MCP HTTP 行为，已经不具备此前的直连、禁代理及凭据限制。后续正式接回时，应由宿主提供业务认证和网络适配，通用 MCP 核心只处理协议与工具。

共享的 [原生公司 HTTP](../packages/agent/runtime/src/tooling/cloud-http.ts)仍用于[统计上传](harness/runtime/native-statistics-upload.md)，相关流式、取消及错误处理测试保留。

## 维护入口

- [通用 MCP 连接实现](../packages/agent/runtime/src/tooling/mcp.ts)与[MCP 测试](../packages/agent/runtime/test/tooling/mcp.test.ts)。
- [共享 HTTP 测试](../packages/agent/runtime/test/tooling/cloud-http.test.ts)。

之前的设备鉴权方案见 [2026-09-21 历史验收](acceptance/saihu-device-access-20260921.md)和[旧业务 Token 清理记录](record/20260922-client-business-token-cleanup.md)，不代表当前仍提供赛狐专用 MCP 接入。
