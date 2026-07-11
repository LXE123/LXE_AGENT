# LXE Agent

本项目是 LXE 内部使用的本地 agent。它通过飞书机器人接收业务请求，
调用本机浏览器、ERP、物流和表格处理能力，并提供本地 Dashboard 查看会话状态。

## 核心能力

- 飞书机器人入口：支持私聊和群聊会话。
- FBA 业务 skill：覆盖马帮、紫鸟、物流、报关、发票和退税等本地流程。
- 本地 Dashboard：默认优先运行在 `http://127.0.0.1:8765/`。
- 会话记录：本地保存 session 统计和 JSONL 聊天记录。
- 可选数据服务同步：可上传 session/token/tool 使用量到 LXE Agent Data Server。

## 运行要求

- Gateway、Runtime、Dashboard 和常驻任务统一运行在 Bun `1.3.14` 单进程中。
- Python 固定使用 `3.12.10`，仅供按需启动、执行后退出的浏览器/ERP/Excel 工具脚本使用，由 `uv` 管理。
- Windows 一键安装脚本会准备 Bun、uv、Python 工具依赖、Playwright Chromium 和 WebUI。
- macOS 可按 `docs/py31210.md` 手工跑通开发环境。
- 真实 `.env`、本机 `.env.local`、业务 Excel 模板和本地数据库不提交 Git。

## 快速安装

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/LXE123/LXE_AGENT/main/scripts/install.ps1 | iex
```

如果提示禁止运行脚本，先执行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

再重新运行安装命令。

启动：

```powershell
LXE start
```

更新：

```powershell
LXE update
```

## 本地配置

- `config/runtime.env` 保存随 Git 分发的非敏感默认运行配置。
- 从 `.env.example` 准备本机 `.env`，只填入飞书、LLM、马帮、紫鸟等敏感或 private 配置。
- 如需覆盖本机非敏感运行配置，写入 `.env.local`；Dashboard 模型/思考模式切换也会写入这个文件。
- 飞书应用需开通 `im:message.reactions:write_only`，用于 best-effort 的 `Typing` 回复中状态；权限缺失只会影响该状态提示，不阻塞正常回复。
- Windows 安装/更新会尝试安装 `dws`；首次使用钉钉能力前需手动运行 `dws auth login`。
- 如需 FBA 模板文件，按 `data/README.md` 准备本机业务数据。
- 启动时默认自动打开 Dashboard；如需关闭，设置 `AGENT_DASHBOARD_OPEN_BROWSER=0`。
- Dashboard 默认使用 `AGENT_DASHBOARD_PORT=8765`；如果端口被占用，会自动切换到一个空闲端口并在日志里输出实际 URL。
- 如需严格固定端口，设置 `AGENT_DASHBOARD_PORT_AUTO_FALLBACK=0`；如需每次都动态分配端口，设置 `AGENT_DASHBOARD_PORT=0`。
- 如需上传使用统计，配置 `LXE_DATA_SERVER_ENABLED`、`LXE_DATA_SERVER_URL` 和 `LXE_DATA_SERVER_API_KEY`。

## 开发检查

```bash
bun install --frozen-lockfile
bun run verify:migration
bun run verify
```

## License

Private Project - Internal Use Only.
