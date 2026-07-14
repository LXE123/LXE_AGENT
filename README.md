# LXE Agent

LXE Agent 是 LXE 内部使用的本地业务 agent。它通过飞书机器人接收请求，调用本机浏览器、
ERP、物流和表格处理能力，并通过本地 Dashboard 展示会话、任务和运行状态。

## 核心能力

- 飞书私聊与群聊会话接入。
- FBA 与补货 skill，覆盖马帮、紫鸟、物流、报关、发票、采购和退税流程。
- 本地 Dashboard，默认地址为 `http://127.0.0.1:8765/`。
- 本地 session、JSONL transcript、任务和使用量记录。
- 可选的 Lark、DingTalk、MCP 和 LXE Agent Data Server 集成。

## 运行架构

- Gateway、Runtime、Dashboard API 和常驻任务运行在 Bun `1.3.14` 单进程中。
- Dashboard 前端位于 `apps/dashboard`，由 Gateway 提供静态资源和 API。
- Python `3.12.10` 仅用于 `lxeskill` 业务命令；浏览器、ERP 和 Excel 脚本按需启动并在执行后退出。
- Python 环境由 `uv` 管理，生产启动不依赖 Python 常驻服务。

## 快速安装

### Windows

在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/LXE123/LXE_AGENT/main/scripts/install.ps1 | iex
```

如当前会话禁止执行脚本，先运行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

安装完成后可使用：

```powershell
LXE start
LXE stop
LXE doctor
LXE update
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/LXE123/LXE_AGENT/main/scripts/install.sh | bash
```

重新打开终端后启动或停止：

```bash
LXE start
LXE stop
```

安装脚本会准备固定版本的 Bun、uv、Python 依赖、Playwright Chromium、Dashboard 构建产物和
`LXE` / `lxeskill` 命令。

## 本地配置

配置按以下职责拆分：

| 文件 | 用途 | 是否提交 Git |
| --- | --- | --- |
| `config/runtime.env` | 随项目分发的非敏感默认值 | 是 |
| `.env` | 飞书、LLM、马帮、紫鸟等 private 配置 | 否 |
| `.env.local` | 本机非敏感覆盖项和 Dashboard 模型设置 | 否 |
| `.env.example` | private 配置示例 | 是 |
| `.env.local.example` | 本地调试配置示例 | 是 |

首次部署时，从 `.env.example` 准备 `.env`。如需覆盖 Dashboard 端口、日志开关或其他运行默认值，
将 `.env.local.example` 中需要的设置复制到 `.env.local`。

其他可选配置：

- FBA 业务模板按 [data/README.md](data/README.md) 放入本机 `data/` 目录，不提交真实 Excel。
- 飞书应用可开通 `im:message.reactions:write_only`，用于 best-effort 的 `Typing` 状态；缺少该权限不影响正常回复。
- 首次使用 DingTalk skill 前运行 `dws auth login`。
- Data Server 同步需要配置 `LXE_DATA_SERVER_ENABLED`、`LXE_DATA_SERVER_URL` 和 `LXE_DATA_SERVER_API_KEY`。
- 无桌面会话时建议设置 `AGENT_DASHBOARD_OPEN_BROWSER=0`；端口被占用时默认自动选择空闲端口。

## 本地开发

安装依赖：

```bash
bun install --frozen-lockfile
uv sync --frozen --all-groups --python 3.12.10
```

前台启动 Gateway：

```bash
bun run gateway:dev
```

停止由 CLI 启动的后台实例：

```bash
bun run gateway:stop
```

运行完整检查：

```bash
bun run verify
```

完整检查包含 TypeScript 生产边界、typecheck、Bun 测试、Python/LXE Skill 测试，以及 Dashboard
和 Gateway 构建。

## 日志

默认只输出适合终端阅读的日志，不写本地日志文件。开发排障可在 `.env.local` 中设置
`LOCAL_LOGS_ENABLED=1`；Bun JSONL 和 Python 文本日志会写入 `var/logs/runtime/<YYYYMMDD>/`。
更多说明见 [docs/harness/logger.md](docs/harness/logger.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/gateway` | Bun Gateway、平台接入、调度和 Dashboard API |
| `apps/dashboard` | React Dashboard 前端 |
| `packages/agent/runtime` | TypeScript agent runtime、LLM 和工具执行 |
| `packages/foundation` | Core 与 Protocol 基础包 |
| `python/lxeskill_cli` | 一次性 Python 业务命令和测试 |
| `skills` | Runtime 加载的业务 skill |
| `config` | 非敏感运行配置和 provider catalog |
| `docs` | 当前文档、设计记录和归档入口 |

文档状态与可信入口见 [docs/README.md](docs/README.md)。

## License

Private Project - Internal Use Only.
