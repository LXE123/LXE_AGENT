# LXE Agent Desktop 技术手册

本文是 `main` 桌面产品线的开发、配置和专题入口。模块职责见 [Electron 模块介绍](../architecture/electron.md)，项目整体关系见 [架构简介](../architecture/README.md)。当前正式分发目标为 Windows x64；macOS 支持源码开发与预览。

## 专题导航

| 需要了解什么 | 阅读入口 |
| --- | --- |
| 工作区、新对话、目录操作与历史窗口 | [工作区与对话](conversation-window.md) |
| 输入框文件引用与技能选择 | [输入框引用](composer-references.md) |
| 定时任务、两种会话方式与桌面 MCP | [定时任务与桌面 MCP](automations.md) |
| 文件预览、手动终端与浏览器 | [侧边栏与文件预览](file-preview.md) |
| 会话状态、问题卡片 | [会话状态](session-status.md)、[结构化提问](../harness/runtime/tools/ask-user-question.md) |
| 进程启停、调度与通信 | [Gateway](gateway/README.md)、[生命周期](gateway/gateway_lifecycle.md)、[JSON-RPC 协议](gateway/agent-protocol.md) |
| 公司设备发现、云端授权与凭据 | [云端接入手册](cloud-access.md) |
| 文件写入权限与单次提权 | [权限专题](../harness/runtime/permission-policy.md) |
| 程序资源、打包与安装 | [打包手册](packaging-pipeline.md) |
| 版本发布与客户端更新 | [Windows 更新与发布](updates.md) |
| 数据目录、升级迁移与数据库 | [程序与用户数据](data-location.md)、[本地数据与存储](../storage/README.md) |
| 日志、诊断与实测证据 | [日志与诊断](../logging.md)、[验收记录](../acceptance/README.md) |

## 本地开发

在仓库根目录安装锁定的 Bun 和 uv 依赖，版本来源为 [package.json](../../package.json)、[pyproject.toml](../../pyproject.toml) 和锁文件。macOS 还需要独立 Node.js >=22.19，Windows 使用准备脚本提供的私有 Node。每个 checkout 和 worktree 使用自己的 `.venv`，具体约定见 [AGENTS.md](../../AGENTS.md#工具链)。

```sh
bun install --frozen-lockfile
uv sync --frozen --all-groups --python 3.12.10
```

| 命令 | 用途 |
| --- | --- |
| `bun run desktop:dev` | 准备资源后启动 Vite 热更新开发环境 |
| `bun run desktop:preview` | 准备资源、构建并启动生产 Renderer 与源码 Runtime |
| `bun run desktop:prepare` | 只准备当前平台所需资源 |

首次准备需要联网，Windows 会准备完整受管运行时；后续复用已校验缓存。任一步骤失败立即停止并保留实际错误。开发模式由 Vite 提供 Renderer 资源，业务请求仍通过桌面 IPC；预览从 `app://lxe/` 加载页面，不启动 Dashboard HTTP 服务。两者都使用当前 checkout 的数据目录，不代替安装包验收。

源码资源位于 `build/desktop-runtime/<平台>-<架构>/`，Windows 沙箱启动器位于 `build/exec-sandbox/`。资源准备与 Desktop 共用路径解析；具体输入、缓存和打包布局见 [打包手册](packaging-pipeline.md)。

验证范围按 [AGENTS.md](../../AGENTS.md#工具链)选择。新 checkout 执行真实 `find` 测试前先运行 `bun run desktop:tools:fd`；正式发布的构建和验收要求见 [Windows 更新与发布](updates.md)。

独立 TUI 的安装和运行说明以 [`lxe-agent-TUI` 分支](https://github.com/LXE123/LXE_AGENT/tree/lxe-agent-TUI)为准。`main` 也提供 [一次性 Agent CLI exec](../harness/runtime/agent_cli_exec.md)，可独立从终端调用。

## 桌面配置与安全

首次启动可接入公司云端，或配置受支持的本地模型 Key，并设置默认工作区。未显式选择时使用数据目录下的 `workspace/`；修改默认目录只影响之后新建的对话。公司与个人模型的选择、配置和兼容规则见 [Provider Catalog](../harness/llm/provider_catalog.md)。

下表的 `<data-root>` 表示实际应用数据目录。默认位置、`LXE_DATA_ROOT` 和迁移规则统一见 [程序与用户数据](data-location.md)。

| 文件 | 用途 |
| --- | --- |
| `<data-root>/config/settings.json` | 模型偏好、集成设置、路径、日志和云端配置 |
| `<data-root>/config/auth.json` | 用户自带的本地模型 Key，以明文 JSON 保存 |
| `<data-root>/config/secrets.bin` | 公司模型凭证及其他由 Electron `safeStorage` 加密的凭据 |
| 源码根目录 `.env` | 开发启动时读取的非模型集成 secret，仅在内存中覆盖对应配置 |
| 源码根目录 `.env.example` | 可提交 Git 的开发配置模板 |

实际配置、凭据、会话和业务数据不提交 Git，也不作为安装包资源输入。LLM catalog 和 MCP defaults 等 Git 文件属于产品策略或契约。

Desktop Main 负责写入配置，版本及兼容格式见 [`config-store/model.ts`](../../apps/desktop/src/main/config-store/model.ts)。`settings.json` 和 `auth.json` 使用锁文件、临时文件和原子替换；非法 JSON 或未经确认的外部修改会显示实际错误并拒绝覆盖。旧 `desktop.json` 首次读取后迁移，并保留带迁移标记的短期备份。

POSIX 创建配置目录时使用 `0700`，`auth.json` 和锁文件使用 `0600`；Windows 依赖实际 NTFS ACL。配置查询只返回本地模型是否已配置、文件路径和读取错误，不向 Renderer 回显 Key。加密配置与明文本地模型 Key 的存储边界分别保留。

源码启动每次读取允许的非模型集成 secret；修改 `.env` 后重启即可生效，不把明文自动写回加密存储。安装版不读取仓库 dotenv 文件。旧模型凭据和配置迁移在 Gateway 启动前完成，不从历史 dotenv 自动导入模型 Key，并删除应用数据目录内的旧 `.env` 和 `.env.local`。

### 公司云端设备接入

已有公司网络连接时可自动识别设备并获取获准能力；需要建立或切换受管连接时导入接入包。接入、模型、网页登录、凭据和缓存统一见 [云端接入手册](cloud-access.md)，统计上传的启用与恢复见 [统计上传](../harness/runtime/native-statistics-upload.md)。

## 私有运行时与工具

Electron 通过 lxeskillCLI 暴露的命令调用业务能力。应用只向自己创建的子进程提供私有工具路径，不修改系统 `PATH`。私有 Agent CLI、Python wheel、Node 和外部工具的构建与分发由 [打包手册](packaging-pipeline.md)维护。

Desktop 启动时在后台运行 `lxeskill list`，独立展示 CLI 入口状态。失败显示实际诊断，不阻塞 Agent 启动或模型的命令调用；桌面重启或“重启 Agent”会重新检查，关闭时取消未完成的检查。这项检查不证明业务认证或全部业务命令可用。

马帮桌面和独立终端的认证入口见 [浏览器认证手册](../../python/lxeskill_cli/browser_auth_service/README.md)；紫鸟页面操作遵循 [官方配对 Selenium 约束](../harness/skill/reference/ziniao-webdriver-doc-1.0.0/reference/automation-framework-policy.md)。Office 能力分工见 [Office 文件能力](../office-runtime.md)。

### 工作台媒体标签

Windows 桌面以及 macOS 源码、预览版的工作台提供“亚马逊 AI 人物标签”。图片支持 JPG、JPEG、PNG，视频支持 MP4 和 MOV。工具向 XMP `dc:subject` 的 `rdf:Bag` 追加 `contains-synthetic-performer`，再重新读取元数据确认写入。它不判断画面是否包含 AI 人物，也不检查其他上传要求。

Electron 管理文件选择和输出目录，Renderer 使用一次性的选择编号和任务编号。Main 调用 `lxeskill media synthetic-performer --stdin-json`，由 CLI 使用私有 ExifTool 处理文件。这条路线不经过 agentcli。原文件保持不变，输出进入独立任务文件夹；同一时间只运行一个媒体任务，关闭应用时清理未完成的处理进程。

macOS 源码启动自动准备并校验项目自己的 ExifTool，缓存于 `build/desktop-runtime/darwin-<arch>/`；也可运行 `bun run desktop:tools:mac` 准备资源，无需另装系统 ExifTool。这项支持覆盖源码开发和预览，不代表已有 macOS 正式发布流水线。

## 日志与诊断

设置页提供 Gateway、agentcli、lxeskillCLI 的状态、后台重启和日志入口。日志位置、档位、脱敏与保留规则见 [日志与诊断](../logging.md)。关闭窗口隐藏到托盘；完整退出时由 Main 按 [生命周期](gateway/gateway_lifecycle.md)停止后台组件及相关子进程。
