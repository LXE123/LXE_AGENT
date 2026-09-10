# browser_auth_service

马帮登录态刷新 CLI。业务请求平时直接读取本地状态；需要刷新时才通过子进程调用本服务，
用 Playwright 重新获取 Cookie、FBA `freeToken` 和 WMS Cookie Header。

状态文件在：

```text
var/db/lxeskill/browser_auth_service/mabang_erp/<account>/state.json
```

里面有 cookie/token，排查时不要粘贴完整内容。登录态只读写这一规范位置；
旧源码目录中的状态已在 TypeScript `main` 晋升时一次性迁移，不再运行时回退。

## 认证材料边界

认证材料的唯一来源是本服务的 `state.json`。刷新命令只返回状态摘要，不返回 Cookie 或 token。
`erp_http_session` / `external_http_session` 使用无状态 CookieJar，不参与认证状态；新流程如果依赖服务端
`Set-Cookie` 连续性，需要显式纳入认证材料或使用局部短命 HTTP session。

## 用 CLI 测统一认证路径

建议先开可视化，方便看页面到底跳到哪里：

```bash
BROWSER_AUTH_HEADLESS=0 uv run --frozen python -m browser_auth_service.main refresh
```

刷新路线固定为：登录 → 库存 SKU → FBA 发货单 → 跳转进入 WMS → 原子写入完整状态。
每次 `refresh` 都会清除旧状态并真实执行整条路线，不存在 Scope、缓存命中或强刷开关。

登录提交后等待真实登录响应成功、页面离开登录流程且 ERP 会话 Cookie 有效，最多等待 40 秒。
若 Chromium 返回已实测的 `Network.getResponseBody: No resource with given identifier found` 错误，
保留原始诊断，并额外要求有效的 ERP 会员 Cookie 才继续；其他响应读取错误直接报错。
库存 SKU 页面加载后每 250 毫秒检查关键 Cookie，齐全就继续，最多等待 12 秒；不再等待全页网络空闲。
FBA 仍等待目标域的 `freeToken`，WMS 跳转和最后 1 秒等待保持原样。
遇到验证码、短信验证或登录失败，保留脱敏后的真实响应，不自动重复提交。

业务请求发现本地状态缺失、过期或不完整时，通过内部 `ensure` 命令自动恢复。`ensure` 会在账户锁内
重新读取状态：第一个调用者执行完整刷新，并发等待者复用它写入的新状态，不再重复启动浏览器。
如果第一个刷新失败，下一位等待者会重新检查状态并接替刷新。服务端明确返回 401/403 后的重试和手工
`lxeskill auth refresh` 仍使用无条件 `refresh`，不会复用服务器已经拒绝的状态。

Windows PowerShell 不支持上面的 Unix 环境变量写法，用这个：

```powershell
$env:BROWSER_AUTH_HEADLESS="0"
uv run --frozen python -m browser_auth_service.main refresh
```

stderr 会实时输出各阶段的开始、成功、实际 URL 或真实错误；stdout 最后一行只输出状态 JSON。重点看：

- `success`
- `final_url`
- `state_written`
- 失败时的 `stage`、`current_url`、`exception_type` 和 `message`

日志中各阶段的成功、失败记录均带 `elapsed_ms`；`stage=refresh` 记录本次刷新的总耗时。
手动刷新总耗时包含账号锁等待；自动 `ensure` 的锁等待单独记录为 `waited_ms`，刷新计时从取得锁后开始。
耗时仅进入日志，不增加 CLI JSON 或状态文件字段。URL 中的认证参数、密码和 Token 会脱敏，过长诊断会显式标注截断。

### 2026-09-10 提速验证

同一机器、账号和临时状态目录下，修改前刷新耗时 29.69 秒，修改后成功刷新耗时 13.68 秒。
这是各一次成功样本，包含网络波动，不能将全部差值视为固定收益。74 项认证定向测试通过。
修改后的凭据通过 ERP 店铺查询（149 条）和 FBA 发货单查询（1 条）。WMS 页面使用新旧凭据均可访问；
两个历史货件的装箱导出均返回 HTTP 200 空响应，原有凭据也复现同样结果。用户确认旧装箱数据会定期删除，
因此该响应符合历史数据被清理的预期，本次未验证到非空装箱文件下载。

## 看复盘日志

需要 `LOCAL_LOGS_ENABLED=1`。日志文件名由系统固定为 `browser_auth_service.log`。

专用日志在：

```text
var/logs/browser_auth_service/YYYYMMDD/browser_auth_service.log
```

macOS / Linux：

```bash
tail -f var/logs/browser_auth_service/$(date +%Y%m%d)/browser_auth_service.log
```

Windows PowerShell：

```powershell
Get-Content -Wait "var\logs\browser_auth_service\$(Get-Date -Format yyyyMMdd)\browser_auth_service.log"
```

## 测试命令

只跑 browser auth 相关单测：

```bash
uv run --frozen python -m pytest -q python/lxeskill_cli/tests/auth
```

编译检查：

```bash
uv run --frozen python -m compileall -q python/lxeskill_cli/browser_auth_service python/lxeskill_cli/tests
```

## 看 state 摘要

只打印域名和 localStorage key，不打印 value：

```bash
uv run --frozen python - <<'PY'
import json
from pathlib import Path

for p in sorted(Path("var/db/lxeskill/browser_auth_service/mabang_erp").glob("*/state.json")):
    data = json.loads(p.read_text(encoding="utf-8"))
    print("state:", p)
    print("cookie_domains:", sorted({c.get("domain", "") for c in data.get("cookies", []) if isinstance(c, dict)}))
    for origin in data.get("origins", []):
        if not isinstance(origin, dict):
            continue
        keys = [kv.get("name", "") for kv in origin.get("localStorage", []) if isinstance(kv, dict)]
        print("origin:", origin.get("origin"), "keys:", sorted(keys), "has_freeToken:", "freeToken" in keys)
PY
```
