# 赛狐 MCP 的设备鉴权

桌面 Agent 的 `lxe-saihu` MCP 由 Bun Runtime 直接连接服务器，携带公开标记 `X-LXE-Client: cli`。服务器根据实际 WireGuard 来源设备和当前 `saihu` 权限授权，不依赖桌面业务 Token、身份检查成功或先执行 `cloud-context`。Skill 范围与实际业务授权分别处理；总体关系见 [桌面云端接入](desktop/cloud-access.md)。

## 配置与连接

[默认配置](../config/mcp_servers.default.yaml)保持关闭，用户按需启用并选择工具范围。首次初始化把默认文件复制到数据目录的 `config/mcp_servers.local.yaml`；已有配置不自动转换或覆盖，启停、工具范围和超时保留原值。

当前连接器要求公司 `lxe-saihu` 使用 `streamable-http` 和 `X-LXE-Client: cli`，不能同时配置 Bearer 环境变量、Authorization、Cookie 或对应环境映射。旧配置不满足时显示明确错误，需要显式调整；不会自动尝试旧鉴权。其他 MCP 连接器保留各自的认证能力。

公司连接使用直接 HTTP／HTTPS socket，忽略系统代理，不发送或保存 Cookie，不跟随重定向。流式响应和实际错误由 MCP SDK 处理。服务器每次调用检查当前授权，管理员身份也不替代业务权限；赛狐上游凭据由服务器维护。

## 维护入口

- [MCP 连接实现](../packages/agent/runtime/src/tooling/mcp.ts)：公司配置校验与其他连接器行为。
- [原生 HTTP](../packages/agent/runtime/src/tooling/cloud-http.ts)：请求头、来源范围、代理和重定向处理。
- [桌面初始化](../apps/desktop/src/main/migration.ts)：已有配置的保留方式。
- [原生通信测试](../packages/agent/runtime/test/tooling/saihu-native-http.test.ts)与 [MCP 测试](../packages/agent/runtime/test/tooling/mcp.test.ts)。

服务端须支持原生设备鉴权后再启用新客户端。旧服务端的兼容策略和独立飞书网关发布由各自仓库维护；本页不把历史部署结果当作当前环境状态。过去的配置自动迁移和跨平台实测见 [2026-09-21 验收](acceptance/saihu-device-access-20260921.md)，随后移除自动转换的背景见 [旧业务 Token 清理](record/20260922-client-business-token-cleanup.md)。
