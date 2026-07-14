# browser_auth_service

马帮登录态刷新 CLI。业务侧通过子进程调用它，用 Playwright 获取/刷新 cookies、FBA `freeToken`、WMS Cookie Header。

状态文件在：

```text
var/db/lxeskill/browser_auth_service/mabang_erp/<account>/state.json
```

里面有 cookie/token，排查时不要粘贴完整内容。登录态只读写这一规范位置；
旧源码目录中的状态已在 TypeScript `main` 晋升时一次性迁移，不再运行时回退。

## 认证材料边界

认证材料唯一来源是本服务的 `state.json` 和 CLI JSON 返回值。`erp_http_session` / `external_http_session` 使用无状态 CookieJar，不参与认证状态；新流程如果依赖服务端 `Set-Cookie` 连续性，需要显式纳入认证材料或使用局部短命 HTTP session。

## 用 CLI 测 4 条认证路径

建议先开可视化，方便看页面到底跳到哪里：

```bash
BROWSER_AUTH_HEADLESS=0 FBA_LOGISTICS_TOKEN_HEADLESS=0 .venv/bin/python -m browser_auth_service.main ensure --scope erp
BROWSER_AUTH_HEADLESS=0 FBA_LOGISTICS_TOKEN_HEADLESS=0 .venv/bin/python -m browser_auth_service.main ensure --scope private_amz
BROWSER_AUTH_HEADLESS=0 FBA_LOGISTICS_TOKEN_HEADLESS=0 .venv/bin/python -m browser_auth_service.main ensure --scope fba
BROWSER_AUTH_HEADLESS=0 FBA_LOGISTICS_TOKEN_HEADLESS=0 .venv/bin/python -m browser_auth_service.main ensure --scope fba --require-wms-cookie-header
```

Windows PowerShell 不支持上面的 Unix 环境变量写法，用这个：

```powershell
$env:BROWSER_AUTH_HEADLESS="0"
$env:FBA_LOGISTICS_TOKEN_HEADLESS="0"
.\.venv\Scripts\python.exe -m browser_auth_service.main ensure --scope erp
.\.venv\Scripts\python.exe -m browser_auth_service.main ensure --scope private_amz
.\.venv\Scripts\python.exe -m browser_auth_service.main ensure --scope fba
.\.venv\Scripts\python.exe -m browser_auth_service.main ensure --scope fba --require-wms-cookie-header
```

重点看输出 JSON：

- `success`
- `source`: `cache` / `refresh` / `relogin`
- `free_token` 是否为空
- `wms_cookie_header` 是否为空

## 看复盘日志

需要 `LOCAL_LOGS_ENABLED=1`，且 `BROWSER_AUTH_LOG_FILE=browser_auth_service.log`。

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
.venv/bin/python -m pytest -q python/lxeskill_cli/tests/auth/test_browser_auth_service_storage_state.py python/lxeskill_cli/tests/auth/test_browser_auth_service_fba_token.py
```

编译检查：

```bash
.venv/bin/python -m compileall -q python/lxeskill_cli/browser_auth_service python/lxeskill_cli/tests
```

## 看 state 摘要

只打印域名和 localStorage key，不打印 value：

```bash
.venv/bin/python - <<'PY'
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
