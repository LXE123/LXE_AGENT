# 智汇 TMS 菲律宾阶段 2 交接：Client 与认证

## 范围

本阶段只实现智汇 TMS 的 Python Client 与认证基础设施：

- `POST /tmsapi/login` 账号密码登录。
- 登录响应的 HTTP、业务码和 `data.apiToken` schema 校验。
- 同一个 `requests.Session` 的 Cookie 保留，以及后续请求的运行时 `token` Header。
- 明确的 connect/read timeout。
- 默认最多 3 次的受控重试：408、429、500、502、503、504 和短暂连接/超时错误。
- HTTP、业务、传输和 schema 错误的真实语义保留、敏感字段脱敏和显式截断。

本阶段没有实现分页、商品导出、下载、XLSX、Skill、Intent、Planner、Catalog 或 Desktop 联调。

## 修改

- `python/lxeskill_cli/services/zhihui_tms/client.py`
  - 新增 `ZhihuiTmsClient` 和 `RetryPolicy`。
  - 登录请求发送 `userName`、`pwd`、`local_time`；首次请求不伪造预登录 token/Cookie。
  - 登录成功后仅在 Client 运行时内保存 `apiToken`。
- `python/lxeskill_cli/services/zhihui_tms/schemas.py`
  - 新增 `LoginResult` 与登录响应校验。
- `python/lxeskill_cli/services/zhihui_tms/errors.py`
  - 新增错误类型、递归响应脱敏、敏感文本替换和长度/深度/集合上限。
- `python/lxeskill_cli/services/zhihui_tms/__init__.py`
  - 暴露阶段 2 的公共 Client、错误和 schema 类型。
- `python/lxeskill_cli/tests/zhihui_tms/`
  - 使用 fake Session、fake response 和非生产 fixture 验证协议行为；没有真实账号和真实外部请求。
- `docs/superpowers/plans/2026-09-17-zhihui-tms-client-auth.md`
  - 记录阶段 2 的实现步骤和边界。

## 关键决策

1. 首次登录不添加文档中尚未确认必需的 `token` 或 `JSESSIONID`；`requests.Session` 负责接收和保留服务端 Cookie。
2. 登录严格要求 HTTP 200、字符串 `code == "200"` 和非空字符串 `data.apiToken`；任何一项不满足都停止。
3. 后续 JSON 请求统一要求 JSON object 和 `code == "200"`，不把业务失败伪装成成功响应。
4. 重试只覆盖明确的临时错误，并通过可注入的 sleep/random 函数测试退避；401、403、业务错误和 schema 错误立即停止。
5. 错误保留服务端观察到的 `msg`/响应体，但对密码、token、Cookie、Session ID 等字段脱敏，并对长文本、深层对象和大集合显式截断。

## 测试

从仓库根目录运行：

```text
UV_CACHE_DIR=/private/tmp/lxe-uv-cache uv run pytest python/lxeskill_cli/tests/zhihui_tms -q
```

结果：`16 passed`。

覆盖内容包括：

- 登录体、Header、Session Cookie 和 timeout。
- 后续请求的 apiToken 注入。
- HTTP 200 的严格要求。
- 503、429、连接错误、超时错误的有界重试和退避。
- 401 不重试。
- 业务失败、非法 JSON、缺少 apiToken 的 schema 错误。
- 错误文本和嵌套 payload 的凭据脱敏与截断。

## 风险与下一步

- 真实 TMS 服务是否要求除账号密码外的预登录 Cookie/token，仍应在人工确认的低频、可停止环境中验证；当前代码不会自行引入该依赖。
- 真实登录后的 Cookie 行为由 `requests.Session` 管理，当前 fixture 验证了 Session 状态保留，但未连接生产服务。
- 下一阶段应在不改变本 Client 错误契约的前提下实现商品列表分页和单页导出，并继续使用 `max_pages`、`max_records`、`max_requests`、`max_runtime` 硬上限。
- 本阶段没有修改 `catalog.json`、Skill、Desktop 或生产账号配置。
