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
      "exposure": "deferred",
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

工具适配保留描述、参数 Schema、平台限制及宿主提供的调用元数据。

每个服务可以通过 `exposure` 指定模型如何发现工具。

| `exposure` | 启用服务后，当前平台的模型入口 |
| --- | --- |
| `codemode`（默认） | 提供 `codemode`。脚本用 `searchTools()` 发现工具，再用 `tools[name](args)` 调用。脚本搜索保持模型可直接调用的工具清单稳定。 |
| `deferred` | 提供 `tool_search`。模型搜索后，命中的工具从下一步开始可直接调用。 |
| `direct` | 连接成功后，模型可直接调用具体工具。 |
| `hidden` | 工具保留在管理目录中，模型和脚本均无法调用。 |

旧值 `auto` 随默认策略走 `codemode`，已有文件按原样保留。只统计当前回合平台上**已启用**的服务，连接状态决定实际可用的工具。两种间接模式并存时，两个入口都会出现。`tool_search` 可加载 `codemode` 和 `deferred` 工具，脚本可调用当前平台允许的非隐藏 MCP 工具。关闭最后一个 `deferred` 服务后，下一次模型请求就会撤下 `tool_search`。详见 [Exposure 模型](README.md#exposure-模型) 和 [桌面 MCP 接口](../../../desktop/automations.md#桌面-mcp-接口)。

### 在 codemode 中查找和调用工具

每轮开始时，agentcli 在 `mcp_servers` 目录中列出当前平台已启用的 `codemode` 和 `deferred` 服务。每行给出命名空间、发现入口和一句简介，例如 `- mcp__lxe_desktop (codemode): 管理桌面定时任务`。简介优先取配置 `connector_description` 的首行，其次取当前连接的服务端 instructions 首行。两者都为空时只列名称和入口。没有符合条件的服务时省略整段。

同一轮的多次模型调用复用这份目录。第一轮把目录放在初始指令里。下一轮发现目录变化时，支持中途指令的模型会在该轮用户输入前收到新版目录，最后一个服务撤下时会收到目录已清空的说明。其他模型在开头的指令里收到最新目录。续聊和分叉按各自的历史回放，压缩摘要保存截断处生效的目录和工具清单。各模型的请求布局见 [模型目录与选择](../../llm/provider_catalog.md)。

`tool_search` 与脚本里的 `searchTools()` 共用 BM25，索引工具名、描述、参数和所属服务的信息。`tool_search` 只搜索当前分支尚未向模型声明的可用间接工具，默认最多加载 8 个。每个命中项只返回名称和首行简介，完整声明从下一次模型请求起生效。脚本搜索可以反复查询已加载的工具，查询本身不会加载它们。

成功加载的工具记入 transcript。续聊或从加载之后的轮尾分叉时，agentcli 按当前注册表、平台和权限恢复声明；从更早的轮尾分叉只继承当时已加载的工具。新记录从本版本开始写入，旧版搜索结果保留在原对话历史中。

`searchTools(query, { limit?, namespace? })` 按 BM25 排序，默认返回前 8 个匹配。每个匹配包含可调用的 `name` 和带 TypeScript 签名的 `description`。已知名称时，`describeTool(name)` 可直接查询同一份声明。`describeNamespace(name)` 返回当前脚本可见的服务简介、服务端指引（如有）及工具名。查询不到的工具或服务返回 `undefined`。

```js
const [hit] = await searchTools("automation_list", { namespace: "lxe_desktop", limit: 1 });
if (!hit) return [];
const result = await tools[hit.name]({});
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

脚本能读取 MCP 原始内容块和结构化值。服务返回的 `isError: true` 仍是脚本可读取的结果，错误内容沿用凭据脱敏规则。连接异常、协议失败、超时和取消会拒绝调用。宿主元数据 `_meta` 留在客户端。模型直接调用 MCP 工具时继续收到适合展示的内容或错误。

脚本也能组合当前会话的四个内置工具。`ls`、`grep` 返回文本，`edit` 返回修改摘要。`read` 读文本时返回不带行号的字符串，仍受分页和输出上限约束；读图片时返回 `{ type: "image", data, mimeType, note }`，可用 `image(await tools.read({ path: "photo.jpg" }))` 将图片交给模型。脚本和直接调用共享同一会话的文件版本记录和编辑权限：先读再改，文件被别人改过就必须重读。一次成功的编辑立即写入文件，即使脚本后续报错，也不会随 `store()` 一起回滚。

### 在多次脚本调用之间保存数据

脚本可用 `store("taskIds", ["a", "b"])` 保存少量 JSON 数据，同一脚本和本对话后续脚本都能用 `load("taskIds")` 读取。同名写入会覆盖旧值，`store("taskIds", undefined)` 删除该键。读取缺失的键返回 `undefined`。当前 Pi 1.5.0 的沙箱无法跨调用保存名为 `__proto__` 的键。

每个成功且有写入的脚本向会话 transcript 追加一条内部记录。脚本报错或执行中被停止时，本次写入会丢弃。重开对话可以恢复已保存的值；从轮尾分叉会继承截至该轮的值，之后两边独立读写。存储记录不会自动进入模型消息，脚本可以用 `return` 或 `text()` 展示需要的部分。
