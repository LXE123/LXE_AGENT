# CLI 云端自检

`lxeskill cloud-status` 用于验证 CLI 离开桌面应用后是否能通过 WireGuard 识别设备并访问马帮查询接口。它是 CLI 内置诊断命令，不属于业务 Skill，不修改命令 catalog。

```powershell
uv run --frozen lxeskill cloud-status --server http://10.88.0.1:8000
```

省略 `--server` 时使用 `LXE_DATA_SERVER_URL`。只接受服务器的 HTTP(S) origin，不接受凭据、路径、查询参数或片段。需保持 WireGuard 在线；自检不要求桌面应用启动，不初始化业务工作区，不读取桌面配置，不申请业务 Token。

自检依次请求：

1. `GET /api/v1/device-context`：显示服务器识别的设备及当前业务权限。
2. `GET /api/v1/data-sources/mabang/apis`：经过真实 `mabang_read` 鉴权，读取服务器维护的接口目录。

请求仅携带公开标记 `X-LXE-Client: cli` 和 JSON Accept 头，不发送 Authorization 或 Cookie，不使用系统代理，不跟随重定向，不自动重试或改用旧 Key。两个接口均不访问马帮上游，因此不受马帮应用有效期影响。

输出遵循现有 CLI JSON 协议，包括 `ok`、`data.checks` 中每一步的 HTTP 状态和耗时、设备权限、马帮接口数量。错误保留服务器真实诊断，凭据脱敏并明确标记截断。退出码：0 成功，2 参数或服务器地址缺失，3 连接失败，4 HTTP 拒绝或响应格式错误，130 用户中断。

收回马帮权限后，设备识别仍应成功，马帮检查应返回 403；停用设备后第一步即应拒绝。线上验证只针对已确认的测试设备，保存原模板及版本，通过正常管理接口切换并恢复；不得修改共享模板影响其他设备。

此命令验证客户端独立运行、网络和设备鉴权，不验证马帮上游凭据有效性，也不代表马帮实际业务查询已成功。现有马帮业务命令及 ERP、模型和管理员凭据流程不因该命令而改变。

## CLI 内部公共通信模块

`shared.infra.cloud_client` 提供与本服务器通信的基础能力。`cloud-status`、采购、装箱、报关和备货 SKU 核验均已接入。上述业务请求通过 WireGuard 设备鉴权，无需桌面业务 Token；详见 `business-cloud-access.md`。

```python
from shared.infra.cloud_client import CloudClient, diagnostic

client = CloudClient.from_env()  # 也可显式传入 server_url
response = client.request_json("GET", "/api/v1/device-context")
```

客户端支持 GET、POST 和 JSON 请求体；POST 使用 `json_body=...`。请求路径必须是本站路径，本轮不接受路径内查询串、跨站地址或路径跳转。不提供自定义认证头，不发送业务凭据，不重试或跟随重定向。默认超时 15 秒、读取上限 1 MiB，可由调用代码通过 `timeout`、`max_response_bytes` 显式设置。

返回值包含 `status_code`、`elapsed_ms`、`payload`、`json_valid`、`truncated`。HTTP 拒绝仍返回实际响应，连接失败抛出 `CloudConnectionError`；业务代码自己判断状态、JSON 结构和业务错误码。`truncated=True` 时不得把结果当作完整数据继续处理。正常数据不会自动脱敏或裁剪，对外展示错误时调用 `diagnostic(...)` 做脱敏和明确截断。

模块不查询或缓存权限，不处理马帮业务码。`request_bytes` 支持文件响应，`AsyncCloudClient` 支持异步请求并管理会话关闭；重试仍由马帮业务适配层决定。用户不需要先运行自检才能使用业务命令。
