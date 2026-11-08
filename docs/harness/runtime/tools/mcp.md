# MCP 配置、连接与工具适配

agentcli 负责 MCP 客户端。用户提供服务器配置后，Runtime 建立连接、发现工具，再把工具交给 Agent 的工具注册表。协议通信仍由官方 MCP SDK 完成。

## 配置文件

默认读取数据目录中的 `config/mcp_servers.local.json`；可用 `LXE_MCP_CONFIG_PATH` 指定另一个 JSON 文件。文件不存在或 `servers` 为空时，没有用户配置的服务器。桌面首次启动会复制空的默认 JSON 模板。

只支持 JSON。旧的 `mcp_servers.local.yaml` 不读取、不迁移、不删除；它里面的服务器不会自动连接。需要继续使用的服务，由用户写入 JSON 文件。显式指定的文件也按 JSON 解析，格式错误直接报告，不回退到其他文件。

```json
{
  "servers": {
    "local_demo": {
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.js"],
      "env": { "SERVICE_API_KEY": "${SERVICE_API_KEY}" }
    },
    "remote_demo": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "X-Client": "agentcli" },
      "bearer_token_env_var": "REMOTE_MCP_TOKEN"
    }
  }
}
```

`enabled` 必须显式写为 `true` 才会启动连接，省略时为关闭。stdio 必须有 `command`，HTTP 必须有 `url`。`args`、`env` 和 HTTP 请求头可省略。HTTP 凭据通过静态 `headers`、环境变量映射 `env_headers` 或 `bearer_token_env_var` 提供；本轮没有新增 OAuth 登录流程。

配置层展开命令、参数和环境变量中的 `${VAR}`。HTTP 请求头里的占位符和令牌在连接时解析；写回开关不会把解析后的秘密写进文件。缺失变量会明确报错。

可选字段沿用现有行为：`startup_timeout_s` 默认 10 秒、`tool_timeout_s` 默认 60 秒；`enabled_tools` 与 `disabled_tools` 使用服务端原始工具名，禁用名单优先；`protocol_mode` 默认 `auto`，也可选 `legacy` 或固定的 `2026-07-28`。JSON 仍接受 `mcpServers` 作为 `servers` 的别名，两者不能同时出现。

配置在宿主启动时加载。现有启停接口会写回 JSON，并通知管理器改变运行状态；手动修改命令、地址等连接参数后需要重启 agentcli。重连使用已加载的配置，不负责重新读取文件。

## 四块职责

源码入口为 `packages/agent/runtime/src/tooling/mcp.ts`，实现位于同级 `mcp/` 目录。

| 文件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `config.ts` | 读取和校验 JSON、展开占位符、写回开关、解析 HTTP 请求头 | 不选择文件存放位置，不保存运行状态 |
| `connector.ts` | 封装 SDK，建立 stdio/HTTP 通信、协商协议、发现和调用工具、关闭连接、报告底层关闭 | 不重连、不注册 Agent 工具，不识别具体业务服务名 |
| `manager.ts` | 启停服务器、维护状态、处理超时与取消、手动重连、注册和移除工具 | 不读写配置文件，不自动重试 |
| `tool-adapter.ts` | 工具过滤、唯一命名、绑定原始工具名、转换调用结果与实际错误 | 不创建连接，不决定连接生命周期 |

`apps/agent-cli/src/runtime-host.ts` 选择配置路径并组装这些模块。`lxe_desktop` 继续通过宿主注入，开关仍由桌面保存；它的凭据和连接定义不写入用户 JSON。

## 连接管理

管理器为每个服务提供 `status(name)`，其中 `state` 表示当前状态：

| 状态 | 含义 |
| --- | --- |
| `configured` | 已加载配置，尚未启动，或管理器已经停止 |
| `disabled` | 用户未启用 |
| `connecting` | 正在准备连接、协商协议并发现工具 |
| `ready` | 连接已经建立，发现的工具已注册；也允许服务没有工具 |
| `error` | 本次连接或注册失败，`error` 保存实际诊断 |
| `disconnected` | 已建立的连接收到 SDK 关闭通知 |

收到关闭通知时，管理器立即移除该连接注册的工具。这里表示 SDK 已观察到连接关闭；HTTP 服务暂时不可达、单次请求失败，不一定意味着整个连接已经关闭。本轮不新增心跳探测。

`setEnabled(name, false)` 会取消启动或关闭连接、移除工具。`setEnabled(name, true)` 对尚未连接的服务发起连接；已经连接时不重复建立。`reconnect(name)` 主动替换已启用服务的连接并重新发现工具，不修改开关，不自动启用关闭的服务。该方法目前供宿主代码调用，没有新增桌面重连按钮或 RPC。

停用、停止和重连会使旧的连接尝试失效。旧连接迟到的结果会被关闭，旧回调不能清理新连接的工具。关闭等待有 5 秒上限，超过上限记录实际超时，避免阻塞其他服务器清理；这不代表一个失控的外部进程一定已经退出。

工具执行失败会返回经过必要脱敏和显式截断的实际错误，并保留最后一次失败诊断；单次工具失败不会把状态从 `ready` 改为 `disconnected`。开始新的连接尝试会清空旧诊断。

## 工具适配与上下文的边界

模型工具名采用 `mcp__<server>__<tool>`，非法字符会替换，过长或冲突时附加哈希。调用时使用单独保存的服务端原始名称，不反向拆解模型工具名。清理按实际注册名称进行，避免相似前缀或截短名称误删其他服务器的工具。

工具适配保留描述、参数 Schema、平台限制及宿主提供的调用元数据；文本、图片、资源和结构化结果沿用 Runtime 的统一处理路径。

**注册工具与工具进入模型上下文是两个阶段。** 用户服务器的 `direct` 工具直接开放，默认 `deferred` 和当前的 `auto` 通过 `tool_search` 按需开放。桌面对话还可以在 `codemode` 脚本中搜索和调用已连接的 `lxe_desktop` 工具，脚本只把选定的结果返回给模型，搜索命中的工具定义不会加入顶层 `tools`。详见 [Exposure 模型](README.md#exposure-模型) 和 [桌面 MCP 接口](../../../desktop/automations.md#桌面-mcp-接口)。
