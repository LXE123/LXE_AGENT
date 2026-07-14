# 仓库结构契约（2026-07-14）

Status: `Current`

`python/lxeskill_cli/tests/infra/test_repo_structure.py` 把本记录中的规则固化为测试。修改冻结集时，先在本目录新增一条带日期的决策记录，再扩测试里的白名单。

## 三条原则

1. **按运行时世界分区**：目录第一层只回答"属于哪个世界"——TypeScript 应用与包（`apps`/`packages`）、Python LXE Skill CLI 闭包（`python/lxeskill_cli`）、技能资产（`skills`）、配置与装配（`config`/`scripts`/`data`）、文档（`docs`）。TypeScript 世界按[大域/小域布局](./20260714-typescript-workspace-domain-layout.md)继续分层。
2. **代码、配置、状态、文档四分离**：程序管理的易失状态（logs、tmp、sqlite DB）收拢进 `var/` 并整目录 gitignore。`artifacts/` 是例外——它是模型可见的输出面（`send_file` 白名单 + 十余处 SKILL.md 硬编码路径），属于工作区契约而非隐藏状态，留在根目录。
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

## 状态目录 `var/`（已完成）

```
var/logs/   ← 所有日志与 trace（Bun JSONL + Python 文本，同一路径分流）
var/tmp/    ← gateway 运行目录、lxeskill 会话锁等 scratch
var/db/     ← local_agent.sqlite3、sessions.json、machine_identity.json、session_transcripts/
```

写保护按路径前缀：`var/db`、`var/logs` 禁写；`var/tmp` 与根 `artifacts/` 可写。`LXE_SQLITE_DB_PATH`、`LOG_FILE`、各 `*_TRACE_DIR` env 未设时才走上述默认；Bun 与 Python 两侧默认值保持一致。

## 后续批次

- Python 收拢已按 [LXE Skill CLI Python 闭包](./20260714-python-lxeskill-cli-closure.md) 完成。
- docs 归类：散文件并入 `harness`（模块契约）/ `record`（决策）/ `goals` / `ops`（安装与网络笔记）。

## 明确不做

- 不采用 `src/` 布局，不修改四个公开 Python package 名称。
- 不迁移存量 env 键名，只约束增量。
- TS workspace 布局由[后续决策](./20260714-typescript-workspace-domain-layout.md)取代。
