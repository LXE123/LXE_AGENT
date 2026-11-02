# lxeskillCLI 云端通信与自检

lxeskillCLI 通过公司 WireGuard 和服务器地址访问云端业务，不要求 Electron 或 agentcli 正在运行，也不要求先执行自检。服务器根据当前设备逐次鉴权；桌面权限缓存不是业务授权凭证。Electron 的调用关系和缓存规则见 [桌面云端接入](../desktop/cloud-access.md)。

## 权限查询与连接自检

```sh
lxeskill cloud-context --server http://10.88.0.1:8000
lxeskill cloud-status --server http://10.88.0.1:8000
```

源码环境可在仓库根使用 `uv run --frozen lxeskill ...`。省略 `--server` 时读取 `LXE_DATA_SERVER_URL`；CLI 不自行填入公司默认地址。地址只能是 HTTP(S) origin，不能包含凭据、路径、查询串或片段。

| 命令 | 请求与用途 |
| --- | --- |
| `cloud-context` | 查询 `GET /api/v1/device-context`，返回设备及四类授权；Electron 用它刷新权限 |
| `cloud-status` | 先查询设备上下文，再请求 `GET /api/v1/data-sources/mabang/apis`，验证当前设备的 `mabang_read` 权限并读取接口目录 |

两条命令在业务初始化之前运行，不创建业务数据库，不读取桌面配置，不申请业务 Token，也不依赖业务 Skill 是否获准。它们不访问马帮上游；自检成功不代表马帮上游登录态或实际业务查询已经成功。马帮网站的按需认证属于业务调用自身的流程。

stdout 输出一个协议版本 `1` 的 JSON 结果。`cloud-context` 成功结果的 `data.device_context` 为 `lxe.device-context.v1`；`cloud-status` 的 `data.checks` 保存每一步的 HTTP 状态与耗时。失败保留实际诊断，做必要脱敏和明确截断。退出码为成功 `0`、参数错误 `2`、连接失败 `3`、HTTP／响应契约错误 `4`、取消 `130`。

两条命令都不自动重试，响应上限均为 1 MiB；`cloud-context` 超时 10 秒，`cloud-status` 每次请求使用客户端默认的 15 秒超时。Electron 的 CLI 桥接另设进程总超时和输出上限，非零退出仍解析结构化错误；无效、矛盾或超限输出不能当作成功。数值与启动实现见 [cloud-context.ts](../../apps/desktop/src/main/cloud-context.ts)。

## CLI 内部通信层

[CloudClient](../../python/lxeskill_cli/shared/infra/cloud_client.py) 和 [AsyncCloudClient](../../python/lxeskill_cli/shared/infra/cloud_async.py) 是 lxeskillCLI 内部公共通信模块。它们负责 HTTP 传输，不缓存授权，不处理业务规则，不依赖桌面状态。

```python
from shared.infra.cloud_client import CloudClient, diagnostic

client = CloudClient.from_env()
response = client.request_json("GET", "/api/v1/device-context")
```

请求携带公开标记 `X-LXE-Client: cli`，不发送 Authorization／Cookie，不使用系统代理，不跟随重定向，也不回退旧 Key。支持 GET、POST 和 `json_body`；路径必须是本站相对路径，不能包含查询串、跨站地址或路径跳转。重试由业务调用方决定。

同步客户端默认超时 15 秒、读取上限 1 MiB；异步客户端默认 60 秒且不限制响应大小，必须通过异步上下文管理器关闭会话。调用方可显式指定 `timeout` 和 `max_response_bytes`。文件下载使用 `request_bytes`。

响应保留 HTTP 状态、耗时、解析结果、JSON 有效性、截断标记、原始 `content` 与必要响应头。HTTP 拒绝仍是响应；连接失败抛出 `CloudConnectionError`。调用方负责判断业务错误码，截断数据不能作为完整结果继续处理；对外展示错误时用 `diagnostic(...)` 脱敏并注明截断，正常业务数据不在传输层擅自裁剪。

## 业务调用

ERP 协作包括采购预览与导入、采购文件重建、合同下载、装箱预览与确认、对账详情和报关预览；备货 SKU 核验包括店铺、Listing、库存 SKU 和组合 SKU 查询。业务文件与参数仍按对应命令准备，直接访问马帮网站时所需的浏览器会话不由云端设备鉴权替代。

ERP 请求需要服务器的 `erp` 能力及相应动作权限，马帮查询需要 `mabang_read`。ERP 超时 30 秒、不自动重试；SKU 查询超时 60 秒，临时故障最多尝试 3 次，认证拒绝和业务失败不重试。采购／装箱的 409 确认与幂等标识由业务层处理。业务显式读取完整响应，自检继续保留响应上限。

## 排查与兼容

先区分服务器地址／网络故障、设备拒绝、业务权限不足和上游业务错误。只有取得实际响应后才能判断对应层；不能把 `cloud-context` 成功当作 ERP、MCP 或马帮均可用。

上线前确认服务器支持对应原生业务接口，再更新 CLI；回滚不兼容的服务端前先协调客户端版本，不添加隐式凭据回退。旧客户端的兼容方式由服务器维护，本 CLI 不申请旧业务 Token。

- [CLI 分流入口](../../python/lxeskill_cli/lxeskill/cli.py)、[权限查询](../../python/lxeskill_cli/lxeskill/cloud_context.py)、[连接自检](../../python/lxeskill_cli/lxeskill/cloud_status.py)。
- [ERP HTTP 适配](../../python/lxeskill_cli/services/commands/mabang/erp_http.py)、[异步马帮查询](../../python/lxeskill_cli/services/mabang/official_api.py)。
- [查询测试](../../python/lxeskill_cli/tests/lxeskill/test_cloud_context.py)、[自检测试](../../python/lxeskill_cli/tests/lxeskill/test_cloud_status.py)、[通信测试](../../python/lxeskill_cli/tests/infra/test_cloud_client.py)、[业务传输测试](../../python/lxeskill_cli/tests/infra/test_cloud_business_transport.py)。

原业务验收的证据范围和未完成项见 [历史说明](../acceptance/cli-cloud-access.md)。线上权限变更验收应使用明确的测试设备并恢复配置，不修改共享模板影响其他设备。
