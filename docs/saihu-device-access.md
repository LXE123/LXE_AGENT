# 赛狐 MCP 接入停用

产品暂时撤下 `lxe-saihu` 专用 MCP 接入，先整理通用 MCP 的配置、连接和工具管理边界。赛狐业务 CLI、业务数据、设备权限和其他公司服务不随之删除。

## 新配置与已有配置

[默认 MCP 配置](../config/mcp_servers.default.yaml)不再预置外部服务器；桌面宿主注入的 `lxe_desktop` 保留。普通 stdio 和 Streamable HTTP 服务仍可通过用户配置接入。

agentcli 在加载 MCP 配置前执行一次宿主迁移：如果存在 `lxe-saihu` 条目，先备份原配置，再将该条目的 `enabled` 设为 `false`。服务器地址、凭据字段、工具范围和超时保留，其他 MCP 条目保持原意。已关闭的配置不重写。

迁移覆盖默认 `config/mcp_servers.local.yaml` 和 `LXE_MCP_CONFIG_PATH` 指定的配置，也支持旧 `servers` 根节点。数据目录的 `migrations/` 保存按配置实际路径区分的 `retire-saihu-mcp-v1-*.json` 完成标记，以及同名 `.yaml.bak` 原文件备份。备份可能包含凭据，以私有文件权限创建，不应提交到版本库。

每份配置在本数据目录中只迁移一次，后续显式修改不会被反复覆盖。解析或备份失败会报告实际错误，停止启动，避免旧连接在移除专用策略后自动改走普通 HTTP。

## 通用连接器与后续接回

Runtime 不再按 `lxe-saihu` 名称选择网络实现或校验公司认证。手动重新启用旧条目会使用普通 MCP HTTP 行为，已经不具备此前的直连、禁代理及凭据限制。后续正式接回时，应由宿主提供业务认证和网络适配，通用 MCP 核心只处理协议与工具。

共享的 [原生公司 HTTP](../packages/agent/runtime/src/tooling/cloud-http.ts)仍用于[统计上传](harness/runtime/native-statistics-upload.md)，相关流式、取消及错误处理测试保留。

## 维护入口

- [宿主配置迁移](../apps/agent-cli/src/mcp-config-migration.ts)与[迁移测试](../apps/agent-cli/test/mcp-config-migration.test.ts)。
- [通用 MCP 连接实现](../packages/agent/runtime/src/tooling/mcp.ts)与[MCP 测试](../packages/agent/runtime/test/tooling/mcp.test.ts)。
- [共享 HTTP 测试](../packages/agent/runtime/test/tooling/cloud-http.test.ts)。

之前的设备鉴权方案见 [2026-09-21 历史验收](acceptance/saihu-device-access-20260921.md)和[旧业务 Token 清理记录](record/20260922-client-business-token-cleanup.md)，不代表当前仍提供赛狐专用 MCP 接入。
