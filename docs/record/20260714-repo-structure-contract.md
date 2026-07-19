# 仓库结构契约（2026-07-14）

Status: `Current`

`python/lxeskill_cli/tests/infra/test_repo_structure.py` 把本记录中的规则固化为测试。修改冻结集时，先在本目录新增一条带日期的决策记录，再扩测试里的白名单。

## 三条原则

1. **按运行时世界分区**：目录第一层只回答"属于哪个世界"——TypeScript 应用与包（`apps`/`packages`）、Python LXE Skill CLI 闭包（`python/lxeskill_cli`）、技能资产（`skills`）、配置与装配（`config`/`scripts`/`data`）、文档（`docs`）。当前 Desktop 应用与基础包布局见 [Desktop 技术手册](../desktop/README.md)。
2. **代码、配置、状态、文档四分离**：程序管理的状态进入项目 `var/`；源码 Desktop 使用仓库或 worktree 的 `var/`，Windows 安装包使用安装目录的 `var/`。`artifacts/` 是模型可见的输出面，不和数据库、日志混写。
3. **规范必须有校验器兜底**：约定不写进测试就必然漂移。

## 命名规范

| 对象 | 规范 |
| --- | --- |
| TS 文件 | kebab-case |
| Python 模块 | snake_case |
| skill 目录 | kebab-case + `SKILL.md` |
| 决策文档 | `docs/record/YYYYMMDD-主题.md` |
| 新增 env 键 | 一律 `LXE_` 前缀；业务域二级前缀（如 `LXE_MABANG_*`）；存量键冻结不迁 |
| 顶层目录 | 白名单冻结（见测试），新增先写决策记录 |

## 逻辑状态根

`LXE_DATA_ROOT` 表示规范 `var` 根，而不是项目根。源码 checkout 未设置该变量时，程序状态继续使用仓库下的 `var/`：

```
var/logs/   ← 所有日志与 trace（Bun JSONL + Python 文本，同一路径分流）
var/tmp/    ← gateway 运行目录、lxeskill 会话锁等 scratch
var/db/     ← 源码模式数据库、sessions.json、machine_identity.json、session_transcripts/
```

Desktop dev/preview 固定使用 `<checkout>/var`；Windows 安装包固定使用 `LXE Agent.exe` 同级的 `<install-root>/var`。Desktop 解析完成后再把该绝对路径作为 `LXE_DATA_ROOT` 下发：

```
<data-root>/db/         ← gateway.sqlite3、agent.sqlite3、lxeskill.sqlite3、sessions.json、transcript
<data-root>/logs/       ← Runtime、Gateway、Python 和 trace 日志
<data-root>/artifacts/  ← Runtime 生成的可发送产物
<data-root>/config/     ← 用户本地 MCP 与 connector 状态
```

源码工作区中的 `var/db`、`var/logs` 继续受模型写保护。安装包的只读资源仍位于 `resources/`，不与可写状态混用。具体数据库所有权见 [本地状态与数据库](../database/local_agent.md)。

## 后续批次

- Python 收拢已按 [LXE Skill CLI Python 闭包](./20260714-python-lxeskill-cli-closure.md) 完成。
- `packages/agent` 只保留 TypeScript `runtime`；已按 [LXE Skill CLI Python wheel 运行时](./20260715-lxeskill-python-runtime.md)删除 Node/Bun 外壳和 PyInstaller 冻结层。
- docs 通过 [文档入口](../README.md) 区分 Current、Needs Refresh、Draft、Archive 和 Reference；模块契约主要进入 `harness`，日期决策进入 `record`。

## 明确不做

- Python 闭包不额外套一层 `src/`，不修改四个公开 Python package 名称。
- 不迁移存量 env 键名，只约束增量。
- 2026-07-14 的 TS workspace 布局记录已被 Desktop 产品结构取代，当前入口见 [Desktop 技术手册](../desktop/README.md)。
