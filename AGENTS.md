# AGENTS.md — AI 编码代理须知

## 项目地图（30 秒版）

- `packages/agent/runtime`：Bun Agent 运行时——会话状态的唯一属主（`db/agent.sqlite3`）。
- `apps/gateway`、`apps/desktop`：编排层与桌面壳；desktop 负责注入各进程的环境变量与 DB 路径。
- `python/lxeskill_cli`：一次性 Python CLI（`lxeskill` 命令）——无状态执行器，自己的表在 `db/lxeskill.sqlite3`。
- `skills/`：模型可见的技能定义；`python/lxeskill_cli/lxeskill/catalog.json` 是模型工具契约，改动必须过测试。
- `docs/harness/`：内部技术文档（紫鸟 API 参考、选型约束、真实响应样本都在这里）。

## 红线（违反 = 生产事故）

- **状态归属**：`agent_sessions` 等会话表只属于 Bun 运行时；Python 侧禁止读写 agent DB，也禁止在 Python DB 里建影子表。浏览器的真实状态在外部（紫鸟客户端实时接口 + CDP 端口），本地只允许可丢弃的缓存。
- **紫鸟浏览器页面自动化只允许官方配对的 Selenium 链路**（`SeleniumRunner` + 按 `core_version` 配对的 chromedriver）。禁止引入 Playwright / Puppeteer / 裸 CDP 做页面级操作——会被站点风控识别，有封店风险。依据与豁免清单见 `docs/harness/skill/reference/ziniao-webdriver-doc-1.0.0/reference/automation-framework-policy.md`。
- **禁止共享或复制 `.venv`**：editable 安装的 `.pth` 指向创建它的 checkout 绝对路径，共享会导致"改的是这份代码、跑的却是另一份"。每个 worktree 各自 `uv sync`（几秒钟，`wt-claim` 已自动做对）。
- **错误真实性**：必须让 AI 看到经过必要脱敏和显式截断的实际错误，不得用无事实依据的推测、通用提示或自写占位文本覆盖实际异常。只有错误形状固定，并有真实响应 fixture 或集成测试证明替代文本与原错误语义等价时，才允许使用固定替代文本；此时仍须在结构化诊断或日志中保留实际错误。

## 工具链

- Python 一律用 `uv`（禁 pip），JS 一律用 `bun`（禁 npm/yarn）；安装带 `--frozen`，不要动 lockfile 之外的版本。
- 测试必须从仓库根运行：`uv run pytest python/lxeskill_cli/tests`。从子目录运行会因相对路径假失败。
- 合并前跑全量测试，不要只跑改动相关的子集。

## 并行开发流程

核心规则：
1. **不要自己 `git worktree add`，也不要删除 worktree。** 用 `scripts/wt-claim` 从常驻池领取一个依赖就绪的 worktree（复用约 0.1 秒，首建约 5 秒，无需下载依赖）。
2. 简单修改直接在主工作区的 `main` 完成并且 `commit`，无需创建分支或询问用户，节约时间和 `Token`。简单修改包括：文档、注释、文案、少量配置，以及影响只在特定局部的代码修改。

适用范围：无人值守 / 并行 agent 任务**必须**走此流程；用户在场的交互式会话按用户指示（用户明确同意时可直接在主工作区修改）。

每个任务的完整流程：

1. **领取**：在仓库任意位置执行 `scripts/wt-claim <task-slug>`（slug 用 kebab-case 描述任务，如 `fix-store-lock`）。脚本输出的最后一行是 worktree 路径，分支自动建为 `codex/<task-slug>`，bun/uv 依赖已同步好。之后所有开发、测试都在这个目录里进行。
2. **开发与验证**：修改 → 完整验证（测试在 worktree 内跑，用它自己的 `.venv`）→ commit。
3. **合并**：把 worktree 分支 rebase 到最新 `main` → 在 worktree 内再次验证 → 在主工作区 fast-forward 合并。多任务并行开发，但必须依次合并；后合并者先 rebase。
4. **归还**：合并完成后执行 `scripts/wt-claim release <task-slug>`。脚本会自动删除已合并的分支并把 slot 还给池子；未合并的分支会保留并提示。

硬性约束：

- 主工作区固定在 `main`，只用于同步、检查、合并和部分简单改动。
- 直接修改 `main` 前必须检查 `git status`，保护用户已有改动，只提交本任务涉及的文件；如果任务实施中不再属于简单修改，应改用 worktree。
- 一个分支只属于一个任务；禁止动别的任务已领取的 slot（`scripts/wt-claim status` 可查占用）。
- 释放前必须工作区干净（committed 或 discard）；`release` 会强制检查。
- 池子默认 4 个 slot，全忙时用 `WT_POOL_MAX=6 scripts/wt-claim <slug>` 临时扩容。

## Windows 编辑安全

- 在 Windows 上，**不要**对含中文、emoji 或其他非 ASCII 文本的 Python 文件做临时性的 PowerShell 整文件重写——会损坏编码、破坏字符串和 docstring。

## commit 规范

- commit 备注用英语，按以下类型开头：

| 类型 | 说明 | 对应版本变更 |
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

## DOCS 规范

- 如果编写文档，分清主次，重点多讲，细枝末节少讲，多用大白话。
