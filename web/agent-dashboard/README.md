# Agent Dashboard WebUI

这里是本地 Agent Dashboard 的前端工程。它使用 React、TypeScript 和 Vite 构建，生产构建产物由同一 Bun Gateway 进程中的 `BunDashboardServer` 静态托管。

这个 README 只说明 WebUI 子项目怎么安装、开发、打包和排查常见问题。完整项目安装、Python 环境和业务配置仍以根目录 `README.md`、`docs/record/20260428-python-3.12.10-uv.md` 为准。

## 环境要求

- Bun `1.3.14`
- 主项目 Python 环境仍按根目录要求使用 `uv + Python 3.12.10`

Windows 用户通常不需要手动准备 Bun；一键安装和 `scripts/webui.ps1` 会尝试发现或安装固定版本 Bun `1.3.14`。

## 安装依赖

在项目根目录运行：

```bash
bun install --frozen-lockfile
```

不要手动编辑 `node_modules`。所有前端工作区的依赖版本以根目录 `bun.lock` 为准。

## 本地开发

启动 Vite 开发服务器：

```bash
bun run --cwd web/agent-dashboard dev
```

默认访问：

```text
http://127.0.0.1:5173/
```

开发模式下，Vite 会把 `/api` 请求代理到：

```text
http://127.0.0.1:8765
```

所以调试 WebUI 前，需要先从项目根目录启动主程序或 Dashboard 后端：

```bash
bun run gateway:start
```

Dashboard 后端默认优先使用 `127.0.0.1:8765`，端口冲突时可能动态 fallback 到其它端口。由于 Vite proxy 默认不会自动跟随动态端口，开发 WebUI 时建议临时固定 Dashboard 端口：

```bash
AGENT_DASHBOARD_PORT=8765 AGENT_DASHBOARD_PORT_AUTO_FALLBACK=0 bun run gateway:start
```

如果固定端口被占用，先停掉旧进程，或者手动调整 `vite.config.ts` 里的 proxy 目标后再调试。

## 构建

生产构建：

```bash
bun run dashboard:build
```

这个命令会先运行 TypeScript 编译，再执行 Vite build。输出目录是：

```text
web/agent-dashboard/dist/
```

构建完成后，主程序启动的 `BunDashboardServer` 会托管 `dist/index.html` 和静态资源。也就是说，用户平时访问的是 Bun Gateway 提供的 Dashboard URL，而不是 Vite dev server。

## 预览

如果只是想检查构建后的静态页面，可以运行：

```bash
bun run --cwd web/agent-dashboard preview
```

`preview` 只预览前端构建产物，不等价于完整 Dashboard。真实 API、会话数据、模型切换、文档读取等能力仍需要后端 gateway/dashboard。

## Windows 脚本

从项目根目录可以使用：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\webui.ps1" -Build
powershell -ExecutionPolicy Bypass -File ".\scripts\webui.ps1" -CheckOnly
powershell -ExecutionPolicy Bypass -File ".\scripts\webui.ps1" -EnsureBuilt
```

- `-Build`：安装依赖并构建 WebUI。
- `-CheckOnly`：检查 Bun `1.3.14`、根工作区锁、WebUI 源文件和 `dist/index.html` 是否存在。
- `-EnsureBuilt`：如果已有构建则检查；没有构建则自动构建。

一键安装和更新脚本也会调用这个 WebUI 构建流程。

## 常见问题

### `dist/index.html` 不存在

说明 WebUI 还没有构建。运行：

```bash
bun install --frozen-lockfile
bun run dashboard:build
```

或在 Windows 上运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\webui.ps1" -Build
```

### Bun 版本不支持

如果脚本提示：

```text
Bun 1.3.14 is required but is not available.
```

请安装固定版本 Bun `1.3.14`，并重新打开终端确认：

```bash
bun --version
```

### Vite 页面能打开，但 API 失败

通常是后端 Dashboard 没启动，或后端端口不是 `8765`。开发模式下默认 `/api` proxy 指向 `127.0.0.1:8765`。

建议先用固定端口启动后端：

```bash
AGENT_DASHBOARD_PORT=8765 AGENT_DASHBOARD_PORT_AUTO_FALLBACK=0 bun run gateway:start
```

### 构建出现 Mermaid chunk size warning

`bun run dashboard:build` 可能提示 Mermaid 相关 chunk 超过 500 kB。这是 Vite 的包体积提示，不等于构建失败。只要命令退出码为 0，并生成了 `dist/index.html`，构建就是可用的。
