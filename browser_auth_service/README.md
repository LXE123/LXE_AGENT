# browser_auth_service

马帮登录态刷新 CLI。业务侧通过子进程调用它，用 Playwright 获取/刷新 cookies、FBA `freeToken`、WMS Cookie Header。

状态文件在：

```text
browser_auth_service/auth_data/mabang_erp/<account>/state.json
```

里面有 cookie/token，排查时不要粘贴完整内容。

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

## 测试命令

只跑 browser auth 相关单测：

```bash
.venv/bin/python -m pytest -q tests/test_browser_auth_service_storage_state.py tests/test_browser_auth_service_fba_token.py
```

编译检查：

```bash
.venv/bin/python -m compileall -q browser_auth_service tests
```

## 看 state 摘要

只打印域名和 localStorage key，不打印 value：

```bash
.venv/bin/python - <<'PY'
import json
from pathlib import Path

for p in sorted(Path("browser_auth_service/auth_data/mabang_erp").glob("*/state.json")):
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
