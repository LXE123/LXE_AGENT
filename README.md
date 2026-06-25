# LXE Agent

本项目是 LXE 内部使用的本地 agent。它通过飞书机器人接收业务请求，
调用本机浏览器、ERP、物流和表格处理能力，并提供本地 Dashboard 查看会话状态。

## 核心能力

- 飞书机器人入口：支持私聊和群聊会话。
- FBA 业务 skill：覆盖马帮、紫鸟、物流、报关、发票和退税等本地流程。
- 本地 Dashboard：默认运行在 `http://127.0.0.1:8765/`。
- 会话记录：本地保存 session 统计和 JSONL 聊天记录。
- 可选数据服务同步：可上传 session/token/tool 使用量到 LXE Agent Data Server。

## 运行要求

- Python 固定使用 `3.12.10`，由 `uv` 管理。
- Windows 一键安装脚本会准备 uv、Python、依赖、Playwright Chromium 和 WebUI。
- macOS 可按 `docs/py31210.md` 手工跑通开发环境。
- 真实 `.env`、业务 Excel 模板和本地数据库不提交 Git。

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

- 从 `.env.example` 准备本机 `.env`，填入飞书、LLM、马帮、紫鸟等真实配置。
- 飞书应用需开通 `im:message.reactions:write_only`，用于 best-effort 的 `Typing` 回复中状态；权限缺失只会影响该状态提示，不阻塞正常回复。
- 如需 FBA 模板文件，按 `data/README.md` 准备本机业务数据。
- 启动时默认自动打开 Dashboard；如需关闭，设置 `AGENT_DASHBOARD_OPEN_BROWSER=0`。
- 如需上传使用统计，配置 `LXE_DATA_SERVER_ENABLED`、`LXE_DATA_SERVER_URL` 和 `LXE_DATA_SERVER_API_KEY`。

## 开发检查

```bash
uv sync --frozen --all-groups --python 3.12.10
uv run --frozen pytest
```

## License

Private Project - Internal Use Only.
