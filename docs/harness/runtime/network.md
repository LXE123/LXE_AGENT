# Harness HTTP 与系统代理

Harness 的模型请求（含摘要、标题和 DeepSeek Files 上传）、HTTP MCP 请求、MCP OAuth 发现、注册、令牌交换和续期共用 `harnessFetch`。桌面启动的 Agent 和独立 `agent-cli` 使用相同规则，不依赖 Electron 网络接口。

## 代理选择

每个请求按以下顺序选择，默认自动生效：

1. 本机回环地址，以及 `NO_PROXY` / `no_proxy` 匹配的目标，直接连接。
2. 使用目标协议对应的 `HTTP_PROXY` 或 `HTTPS_PROXY`；未设置时使用 HTTP/HTTPS 类型的 `ALL_PROXY`（SOCKS 类型不参与选择）。支持小写变量；同名大小写同时存在时小写优先。代理地址须为 HTTP/HTTPS。
3. 没有显式代理变量时，读取系统的手动代理。macOS 使用 `scutil --proxy` 的全局 HTTP/HTTPS 配置；Windows 读取当前用户 Internet Settings 中的 `ProxyEnable`、`ProxyServer`、`ProxyOverride`。
4. 系统绕过名单命中的地址，或未配置对应协议代理时，直接连接。支持主机通配符、IP/CIDR 和 `<local>` 简单主机名。其他平台继续使用环境变量或直连。

系统设置缓存 5 秒，同一进程的并发请求共用一次查询。更改系统代理会在缓存过期后的新请求中生效；已建立的流不会被强制断开。系统设置读取失败会保留实际异常，选中的代理连接失败也不会悄悄退回直连。

HTTP 重定向按新 URL 重新选择代理；跨源跳转移除 Authorization、Cookie 等敏感头，保留调用方取消信号。调用方指定 `redirect: "error"` 或 `"manual"` 时继续遵循原行为，MCP OAuth 请求仍禁止自动跳转。

代理请求通过 Bun fetch 发送；显式直连使用独立的 Undici Agent。原因是项目固定的 Bun 1.4.2 会忽略 `proxy: false` 并重新读取环境代理，不能靠该选项保证绕过规则生效。两种传输都保留 TLS 校验和流式响应。

## 范围与诊断

本版只读取手动 HTTP/HTTPS 代理，暂不执行 PAC、不进行 WPAD 自动发现，也不使用系统 SOCKS 配置。系统只有自动代理配置时，不会把它当作手动代理；可显式设置 HTTP/HTTPS 代理环境变量。不会修改操作系统代理、全局 `fetch` 或子进程环境；`exec` 启动的外部程序、stdio MCP 子进程自行处理网络。公司统计上传继续使用其已有的专用直连传输。

`runtime.network` 的 debug 事件 `http_request_route` 记录目标 origin、选择来源（environment/system/bypass/direct）和代理 origin，不记录请求路径、查询参数、认证头或代理密码。连接错误由现有模型、MCP 和 OAuth 链路保留真实诊断；网络层不新增重试。

实现入口：[统一请求](../../../packages/agent/runtime/src/network/fetch.ts)、[系统配置读取](../../../packages/agent/runtime/src/network/system-proxy.ts)。从仓库根目录运行 `bun test packages/agent/runtime/test/network`，验证代理选择、重定向、取消和上传；系统代理读取与真实网络连通性需在目标操作系统上验证，验收结果记录在对应 PR。
