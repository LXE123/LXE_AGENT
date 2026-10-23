# AGENTS.md — AI 编码代理须知

## 项目地图（30 秒版）

- **Electron**：面向用户的应用入口。`apps/dashboard` 提供桌面界面，`apps/desktop` 负责主进程、侧栏与文件预览、系统集成、配置和进程管理，`apps/gateway` 负责渠道接入、任务调度和结果交付。
- **agentcli**：独立的 Agent Harness。`apps/agent-cli` 是命令行宿主，`packages/agent/runtime` 是 Bun Agent 执行核心，负责模型调用、上下文、工具、会话、执行权限和统计。
- **lxeskillCLI**：`python/lxeskill_cli` 中按次启动的业务 CLI，通过 `lxeskill` 暴露业务命令，独立管理业务数据、配置和文件产出。
- **Skill**：`skills/` 存放通用和业务指引，为模型提供任务知识与工作上下文。
- **文档**：[README](README.md#架构) 提供整体架构，[docs/README.md](docs/README.md) 是专题入口；Electron、agentcli 和 lxeskillCLI 的技术手册分别位于 `docs/desktop/`、`docs/harness/` 和 `docs/lxeskill-cli/`，共享能力与外部参考从文档入口查阅。

## 模块协作与 Skill 工作上下文

- Electron 与 agentcli 通过 **JSON-RPC 2.0** 通信，使用 stdin/stdout 传输。
- Electron 通过 lxeskillCLI 暴露的命令调用业务能力；标记为 `internal` 的集成命令也属于 CLI 契约，不等于直接调用内部模块或函数。
- 对 agentcli 而言，lxeskillCLI 与其他外部 CLI 一样，由模型通过 `exec` 调用。lxeskillCLI 的安装与运行不是 Agent Harness 自身成立的前提。
- `python/lxeskill_cli/lxeskill/catalog.json` 由 lxeskillCLI 内部维护；Electron 和 agentcli 的集成代码按需通过 `lxeskill list`、`lxeskill describe ...`、`lxeskill datasets list` 查询契约，不直接加载该文件。
- Electron 预览使用 LibreOffice Kit 的 Node API；模型通过 `exec` 调用 Kit CLI；lxeskillCLI 通过内部适配调用 Kit CLI 完成业务文件处理。详见 [Office 文件能力](docs/office-runtime.md)。

Skill 可以根据任务需要，向模型介绍 Electron、lxeskillCLI 等模块的内部结构、实现细节、数据组织和操作方法。这些说明属于工作上下文，本身不构成程序模块之间的耦合，也不改变各模块的职责和数据归属。模型按任务使用通用 Tool 时，遵循任务要求和执行权限。

编写 Skill 时，优先讲清输入、依赖和正确执行路径，不要针对每次误判不断追加禁止事项。

审查 Skill 时关注指引是否准确、是否有助于任务；实现变化后同步更新相关指引。审查程序模块依赖时，关注生产代码是否绕过约定接口、直接依赖其他模块的内部实现或存储结构。

## 红线（违反 = 生产事故）

- **状态归属**：各模块的生产实现分别管理自身数据，通过约定接口协作，不把其他模块的内部存储作为集成接口，也不建立对方状态的副本来替代接口。Electron 管理桌面配置、凭据、缓存及 Gateway 接入数据；agentcli 管理 Agent 会话、执行状态和统计，SQLite 保存状态与索引，JSONL transcript 保存消息和工具记录；lxeskillCLI 管理业务数据与配置。桌面运行时的数据库分别为数据目录下的 `db/gateway.sqlite3`、`db/agent.sqlite3` 和 `db/lxeskill.sqlite3`。
- **紫鸟状态**：浏览器真实状态以紫鸟客户端实时接口和浏览器实际状态为准，本地只保留可丢弃的缓存。
- **紫鸟浏览器页面自动化只允许官方配对的 Selenium 链路**（`SeleniumRunner` + 按 `core_version` 配对的 chromedriver）。禁止引入 Playwright / Puppeteer / 裸 CDP 做页面级操作——会被站点风控识别，有封店风险。依据与豁免清单见 `docs/harness/skill/reference/ziniao-webdriver-doc-1.0.0/reference/automation-framework-policy.md`。
- **禁止共享或复制 `.venv`**：editable 安装的 `.pth` 指向创建它的 checkout 绝对路径，共享会导致"改的是这份代码、跑的却是另一份"。每个 worktree 各自 `uv sync --frozen`，`wt-claim` 会自动同步。
- **错误真实性**：必须让 AI 看到经过必要脱敏和显式截断的实际错误，不得用无事实依据的推测、通用提示或自写占位文本覆盖实际异常。只有错误形状固定，并有真实响应 fixture 或集成测试证明替代文本与原错误语义等价时，才允许使用固定替代文本；此时仍须在结构化诊断或日志中保留实际错误。

## Instruction Handling

When you receive an instruction:

1. If the instruction is incorrect, explain why.
2. If the instruction is ambiguous, ask for clarification.
3. Otherwise, carry out the instruction.

## 工具链

- **依赖管理与源码开发**：Python 使用 `uv`，不直接用 pip 管理依赖；JS/TS 使用 `bun`，不使用 npm/yarn 管理依赖。安装分别执行 `uv sync --frozen` 和 `bun install --frozen-lockfile`，依赖版本以声明文件和 lockfile 为准。
- **运行时调用**：按被调用程序的接口要求执行。上面的开发工具约定不禁止产品使用 Node.js、随包 Python 或其他运行时，例如 Kit CLI 使用独立 Node.js；不要为了统一开发工具而改写已有运行接口。
- **Obsidian 协作**：需要访问 Obsidian 时，先发现当前机器上的 CLI 路径，并用 `obsidian vaults` 确认 Vault，不要写死安装位置或笔记目录。若 CLI 已安装且应用正在运行，但沙箱因看不到应用 IPC 而误报未运行，申请在沙箱外执行，并将命令前缀限制为实际 CLI 路径；若未安装或未启用 CLI，明确说明，并在已知 Vault 路径时回退为直接读写 Markdown，否则询问用户。默认只读；只有用户明确要求维护笔记时才执行写操作，不执行 `eval` 或插件管理命令。
- 测试必须从仓库根运行，Python 定向测试使用 `uv run --frozen pytest <测试文件或目录>`。从子目录运行会因相对路径假失败。
- **验证必须拿真实结果，警惕假通过**：管道会吞掉退出码（`cmd | tail` 的退出码是 tail 的，不是 cmd 的——用 `set -o pipefail` 或先落盘再查 `$?`）；扫描类校验匹配到空集也会"通过"（cwd 漂移、glob 写错时扫了 0 个文件照样报绿）。报告通过之前，先确认命令真的执行了、扫描真的扫到了东西。
- agentcli 的统计适配通过 `lxeskill list` 查询命令归属。修改命令契约时，两端定向测试都要跑：`uv run --frozen pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` 加 `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`。
- 按改动的实际影响范围完成必要验证，局部改动优先做定向检查；影响广泛或难以界定时，再扩大验证范围，必要时运行全量验证。合并前确认验证仍适用于当前代码和最新基线，避免无变化的重复验证。

## 开发与 PR 流程

- 所有仓库改动在任务分支完成，通过 PR 合并到 `main`。主工作区保持在 `main`，用于同步和检查。
- AI 根据任务情况选择合适的工作区；需要独立 worktree 时，通过 `scripts/wt-claim` 或 Windows 版本 `scripts/wt-claim.ps1` 领取和归还，不占用其他任务的工作区。用法见 [worktree 脚本说明](scripts/README.md#worktree-池)。
- 修改和提交前检查 `git status`，保护已有改动，只提交当前任务涉及的内容。
- 按改动范围完成必要验证，并遵循 [PR 审查规范](docs/pr-review.md)。AI 说明实际验证结果和未确认事项；需要人工审核的改动，经审核通过后合并。
- 修改已提交、推送并创建 PR 后，可以归还干净的 worktree，保留任务分支；需要继续修改时重新领取。
- AI 代为合并 PR 时，需要已有明确授权。

## Windows 编辑安全

- 在 Windows 上，**不要**对含中文、emoji 或其他非 ASCII 文本的 Python 文件做临时性的 PowerShell 整文件重写——会损坏编码、破坏字符串和 docstring。

## commit 规范

- commit 备注用英语，按以下类型开头：

| 类型 | 说明 | 版本选择参考 |
| :--- | :--- | :--- |
| **feat** | 新增功能 (Feature) | `Minor` |
| **fix** | 修复 Bug | `Patch` |
| **docs** | 仅文档修改 | 无 |
| **style** | 不影响代码含义的修改（空格、格式化、分号等） | 无 |
| **refactor** | 代码重构（既不是修复 Bug 也不是新增功能） | 无 |
| **perf** | 提高性能的修改 | `Patch` |
| **test** | 添加或修改测试用例 | 无 |
| **chore** | 构建过程或辅助工具的变动（如更新依赖） | 无 |
| **ci** | 持续集成配置文件或脚本的变动 | 无 |

版本列仅供发布时参考，不表示每个 commit 都要升级版本。正式版本和更新说明由发布者在 `config/desktop-release.json` 中显式设置；commit 类型不会自动递增版本。详见 [Windows 更新与发布](docs/desktop/updates.md)。

## DOCS 规范

- 如果编写文档，分清主次，重点多讲，细枝末节少讲，多用大白话。
