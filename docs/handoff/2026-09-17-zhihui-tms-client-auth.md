# 智汇 TMS 核心功能 1 交接

## Status

READY_FOR_REVIEW

## Scope

已完成智汇 TMS Client 与登录认证的最小可测试实现。未实现商品分页、批量导出、下载、XLSX 合并、Skill、catalog 或 Desktop 联调。

## Files Changed

- `python/lxeskill_cli/services/zhihui/tms_client.py`：认证 Session、JSON 请求封装、timeout、瞬时错误重试、响应校验和错误脱敏。
- `python/lxeskill_cli/services/zhihui/__init__.py`：公开 Client 与认证错误类型。
- `python/lxeskill_cli/tests/zhihui/test_tms_client.py`：登录成功、Token 缺失和 503 重试 fixture 测试。

## Contract

- 登录 endpoint 为 `/login`，请求字段为 `userName`、`pwd`、`local_time`。
- 成功必须同时满足 HTTP 2xx、`code == "200"` 和非空 `data.apiToken`。
- 后续请求使用运行时 `token` header；认证状态不足时明确报错。
- 用户名/密码从显式参数或 `LXE_ZHIHUI_TMS_USERNAME`、`LXE_ZHIHUI_TMS_PASSWORD` 读取。

## Decisions

- 使用现有共享 aiohttp 外部会话，继承项目的无 Cookie 自动持久化边界。
- timeout 固定为 30 秒；408、429、500、502、503、504 和连接/超时异常最多重试 3 次，退避为 1、2 秒。
- Token 和 Cookie 字段设置为不出现在 dataclass repr 中；诊断信息对敏感字段脱敏并截断。
- 登录响应的 `Set-Cookie` 当前只作为运行时 header 原值保留，后续真实接口验证时需确认是否应提取 `JSESSIONID`。

## Validation

```text
uv run pytest python/lxeskill_cli/tests/zhihui/test_tms_client.py -q
3 passed
```

## Known Gaps / Risks

- 尚未使用真实账号验证服务端是否要求预登录 Token、Origin、menu-path 或 JSESSIONID。
- 尚未验证 TMS 返回的下载文件实际 MIME 和 XLS/XLSX 格式。
- `Set-Cookie` 的多值解析应在后续核心功能或真实联调前补充，避免把 Cookie 属性误作为 Cookie header。
- 尚未接入项目 `catalog.json`，因此当前 Client 不能被 Desktop 自然语言直接调用。

## Next Step

下一个独立核心功能应实现商品列表分页和按页批量导出，复用本 Client 的 Session；先补充分页 fixture、重复页保护、数量上限和真实 `pop` 下载地址提取。

## Do Not

- 不要在当前交接任务中继续实现下一核心功能。
- 不要把真实凭据、Token、Cookie 或生产响应提交到 Git。
- 不要仅依赖 `pop.totalPage` 控制分页。
