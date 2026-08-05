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
