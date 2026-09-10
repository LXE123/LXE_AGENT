# browser_auth_service

马帮登录态刷新 CLI。业务请求平时直接读取本地状态；需要刷新时才通过子进程调用本服务，
通过桌面提供的 Electron 窗口，或手动绑定的 Chrome/Edge，重新获取 Cookie、FBA `freeToken` 和 WMS Cookie Header。

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

桌面内发起的业务调用自动使用 Electron。独立终端运行时，先绑定本机浏览器的实际可执行文件：

```bash
uv run --frozen lxeskill auth browser bind --executable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
uv run --frozen lxeskill auth browser status
uv run --frozen lxeskill auth refresh
uv run --frozen lxeskill auth browser unbind
```

Windows 示例：

```powershell
uv run --frozen lxeskill auth browser bind --executable "C:\Program Files\Google\Chrome\Application\chrome.exe"
# 或指定 Edge；两者任选其一，不扫描或自动切换。
uv run --frozen lxeskill auth browser bind --executable "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

绑定会在临时环境启动一次空白页，验证成功后才保存路径；替换失败保留原配置。
配置位于当前 `LXE_DATA_ROOT` 对应的 `config/mabang-auth-browser.json`，只保存版本与程序路径，
不依赖桌面设置或账号。`status` 只检查路径和选择来源，不启动浏览器；`unbind` 不删除已有登录态。
第一版验证 Chrome/Edge；不会连接个人浏览器标签页或复用其用户配置。独立 CLI 无绑定且需要刷新时会报错。

### 浏览器来源与状态归属

Python 中的登录路线、账号锁、等待与校验只有一份。桌面注入 `LXE_AUTH_BROWSER_HOST_URL` 和
`LXE_AUTH_BROWSER_HOST_TOKEN` 时使用宿主适配器；未注入时使用绑定路径和 Playwright 控制库。
宿主配置不完整、连接失败或绑定失效时直接报告实际错误，不自动切换后再次提交登录。
有效缓存的读取不需要 Electron、浏览器绑定或浏览器进程。

Electron 主进程提供回环地址上的 `/v1/auth-browser` 协议，限定为认证需要的导航、表单操作、
响应捕获、Cookie 和 frame 存储读取。每次认证创建独立内存 session 与窗口，页面没有桌面 preload、
Node 权限或业务事件。操作结束关闭窗口；客户端中断、桌面退出或会话闲置 180 秒后也会清理。
密码、宿主令牌和材料只通过内存与已鉴权的本机连接传递，不写入浏览器绑定配置或日志。

两种浏览器最终都交由 Python 完整校验并原子保存同一份 `state.json`。
桌面安装包保留 Playwright 控制库和共享 Node 驱动运行时，但不再附带独立 Chromium。

### 查看刷新过程

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

### 2026-09-11 Windows 双入口验证

开发和提交均在 Mac 完成，Windows 只在独立 worktree 导入 Git bundle、安装自己的依赖并验证。
对比基线为 `59d080fb`；Windows 10 x64，Python 3.12.10，Electron 43.1.0（Chromium 150.0.7871.47），
Chrome 152.0.7977.76，Edge 147.0.3912.72。以下均为同机各一次真实刷新，单位秒；包含网络和系统波动。

| 阶段 | 基线独立 Chromium | Electron | 绑定 Chrome | 绑定 Edge |
| --- | ---: | ---: | ---: | ---: |
| 浏览器准备 | 2.34 | 0.06 | 1.20 | 1.25 |
| 登录 | 2.44 | 3.78 | 1.83 | 2.06 |
| 库存 Cookie | 3.03 | 2.36 | 3.30 | 2.78 |
| FBA Token | 1.33 | 1.30 | 1.31 | 4.41 |
| WMS | 4.39 | 4.11 | 4.08 | 9.69 |
| 采集完整状态、校验并保存 | 0.28 | 0.02 | 0.28 | 13.08 |
| 整次刷新（含关闭资源） | 14.00 | 11.69 | 12.17 | 39.69 |

Electron 的浏览器准备只计独立认证窗口创建，不包含桌面进程启动，符合复用已运行桌面内核的使用方式。

四次凭据均通过 ERP 店铺查询（149 条）、FBA 发货单查询（20 条）和 WMS 登录后页面访问。
原装箱导出均为 HTTP 200 空响应，按正常业务结果处理。Edge 样本耗时较高，现有阶段日志只能定位到
WMS 和状态采集保存，不能据此认定浏览器或网络的具体原因，也不能承诺所有路线都会提速。

最终源码候选 `aef4be1a` 的未修改 Windows 成品也已验证：应用的 Gateway、Agent CLI 和 lxeskill
健康检查均为 ready；从正常设置入口保存测试账号后，由维护调度触发完整 Electron 认证，耗时 13.98 秒，
所得凭据通过上述四项业务检查。退出成品后，包内 Python CLI 绑定 Chrome 完成一次刷新（12.80 秒）；
随后解绑，继续用同一缓存通过业务检查，测试桌面进程数为 0。

成品验证发现并修正了维护调度遗留的 `--scope erp` 参数，调度现在调用统一的 `auth refresh`。
验证器最初通过 Playwright 连接整个 Electron 调试端口，会同时附着新认证窗口；该次登录超时。
改为仅连接应用主页面、配置后断开测试连接，完整认证成功。没有在产品中增加测试专用入口。

Mac 完成一次全量 `bun run verify`：Bun 1,482 项通过，Python 1,629 项通过、2 项跳过。
之后的维护参数修正补跑 13 项相关 Bun 测试和运行时类型检查。Windows 的 356 项 Python 定向测试、
56 项 Bun 定向测试及维护修正的 13 项测试通过；两端的真实 Electron 本地页面 fixture 均通过，
涵盖目标域 Token、初始 Cookie 防误判、验证码不重试、失败不保存和客户端断开后的窗口回收。

合并前 main 新增其他任务提交，因此又 rebase 到 `6d347093`，并重新完成组合版本全量验证：
Bun 1,502 项、Python 1,629 项通过，2 项跳过。Windows 扩展桌面检查为 235 项通过、9 项跳过；
唯一失败是已有 macOS WireGuard 测试在 Windows 上断言 POSIX `0600` 权限（实际为 `0666`），
该项在 Mac 全量验证中通过。此平台测试限制不影响上述认证验收。
组合版本的 Windows 成品重新构建并通过无凭据启动健康检查，体积 760.87 MiB，独立 Chromium 仍为 0 字节。

Windows 解包产物从 1,157.81 MiB 降至 760.84 MiB，减少约 397 MiB（34.3%）。
资源报告确认独立 Chromium 为 0 字节，Python Playwright 控制库保留，共享 Node 仍可用。
首次重建运行时两次在 PowerShell 目录替换时报 `Move-Item: Access ... is denied`；随后独立复制和替换
同一任务目录成功，再使用候选运行时完成构建。失败日志保留，尚未确认拒绝访问的具体原因。

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

真实 Electron 页面测试使用本机虚构站点和测试凭据，不会登录真实马帮。从仓库根构建
`apps/desktop/scripts/auth-browser-smoke.ts`（`bun build --target node --format esm --external electron`），
用 Electron 启动生成的 `.mjs`，后接当前 worktree 的 Python 可执行文件和
`python/lxeskill_cli/tests/auth/browser_host_fixture.py` 绝对路径。它验证跨域 Cookie、目标域 Token、
WMS 跳转后的存储、验证码失败不重试以及失败不保存半成品。

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
