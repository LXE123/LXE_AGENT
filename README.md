# LXE Agent Desktop

LXE Agent Desktop 是 LXE Agent 的默认产品线。它把现有 Dashboard、Gateway、Agent Runtime、
业务 skill 和私有运行时装进 Windows Electron/NSIS 桌面应用，用户不需要预装 Bun、Node.js
或 Python。

## 核心能力

- 飞书私聊与群聊会话接入。
- FBA 与补货 skill，覆盖马帮、紫鸟、报关、发票、采购和退税流程。
- 复用现有 Dashboard 的 Electron 管理界面，不额外启动本地 Web 服务。
- 本地 session、JSONL transcript、任务和使用量记录。
- 可选的 Lark、DingTalk、MCP 和 LXE Agent Data Server 集成。
- 托盘、后台组件状态、工作区和私有凭证管理。

## 运行架构

- Electron Main 使用 Electron 自带的 Node.js 运行 Gateway，并管理窗口、托盘、配置和子进程生命周期。
- Dashboard 位于 `apps/dashboard`；正式包通过安全的应用协议加载，并通过白名单 IPC 访问 Gateway。
- `agent-cli.exe` 由 Bun `1.3.14` 和 TypeScript 编译，通过 NDJSON 标准输入输出与 Electron Main 通信。
- `lxeskill` 保持 Python 原生实现；构建时生成 wheel，安装到随包私有 Python，并以
  `python -I -m lxeskill` 按需执行。
- 私有 Node.js、Python、ripgrep 和 Playwright Chromium 只对应用子进程注入，不修改系统 PATH。

## Windows 桌面安装

当前支持 Windows x64。CI/发布机通过以下命令生成 NSIS 安装程序：

```powershell
bun run verify:platform:win
```

产物位于 `dist/desktop/`，文件名为 `LXE-Agent-<version>-windows-x64.exe`。本轮只调整默认产品分支，
尚未发布 GitHub Release；内部测试请使用经过 Windows 门禁验证的 Setup.exe。

## 源码 / TUI 产品线

需要源码安装、终端命令和浏览器 Dashboard 的用户，请使用独立维护的
[`lxe-agent-TUI`](https://github.com/LXE123/LXE_AGENT/tree/lxe-agent-TUI) 分支。

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/LXE123/LXE_AGENT/lxe-agent-TUI/scripts/install.ps1 | iex
```

如当前会话禁止执行脚本，先运行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/LXE123/LXE_AGENT/lxe-agent-TUI/scripts/install.sh | bash
```

为兼容历史 raw `main/scripts/install.*` 链接，本分支仍保留源码安装器；它的默认 ref 同样是
`lxe-agent-TUI`，不会把桌面源码当成 TUI 安装。

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

构建当前源码 wheel，并验证 wheel 包含四个 Python 业务包：

```bash
rm -rf build/wheel-smoke
uv build --wheel --out-dir build/wheel-smoke --clear --no-create-gitignore
```

Windows Electron 打包器会自动完成 wheel 构建、安装和源码 catalog 完整命令集合冒烟验证，外部入口仍为
`bun run desktop:dist:win`。

完整检查包含 TypeScript 生产边界、typecheck、Bun 测试、Python/LXE Skill 测试，以及 Dashboard
和 Gateway 构建。

跨平台发布门禁还会构建当前 wheel、原生 Agent CLI、Dashboard 和 Electron main/renderer：

```bash
bun run verify:platform:mac
```

Windows x64 使用更完整的门禁，并在上述检查后实际生成 NSIS 安装包：

```powershell
bun run verify:platform:win
```

Desktop 可分发产物目前仅支持 Windows x64。macOS 门禁验证 macOS 原生 wheel/Agent CLI 和
Electron 源码构建，并静态验证 Windows Builder 配置；在引入受管 macOS Node/Python/浏览器运行时、
签名与 notarization 之前，不生成缺少私有运行时的伪 DMG。

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
