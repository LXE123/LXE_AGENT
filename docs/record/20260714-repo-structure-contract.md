# 仓库结构契约（2026-07-14）

`python/lxeskill_cli/tests/infra/test_repo_structure.py` 把本记录中的规则固化为测试。修改冻结集时，先在本目录新增一条带日期的决策记录，再扩测试里的白名单。

## 三条原则

1. **按运行时世界分区**：目录第一层只回答"属于哪个世界"——TypeScript 应用与包（`apps`/`packages`）、Python LXE Skill CLI 闭包（`python/lxeskill_cli`）、技能资产（`skills`）、配置与装配（`config`/`scripts`）、文档（`docs`）。当前 Desktop 应用与基础包布局见 [Desktop 技术手册](../desktop/README.md)。
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
<data-root>/config/     ← 桌面配置、凭据、本地 MCP 与 connector 状态
<data-root>/inputs/     ← 用户通过桌面上传的业务模板
```

安装包的程序资源位于 `resources/`，受管状态位于 `var/`。这是资源与状态的组织约定；模型文件工具与 Shell 使用宿主用户权限，没有对 `var/db` 或 `var/logs` 提供写保护。具体数据库所有权见 [本地状态与数据库](../database/local_agent.md)。

业务模板由桌面上传并登记到 catalog 的 `input_assets`，保存于 `var/inputs/<slot>/current/`，保留一个 `previous/` 版本。仓库不再设 `data/` 模板目录，不通过手工向源码目录复制 Excel 配置业务。

## 运行时布局

Python 实现与测试集中在 `python/lxeskill_cli/`，容器目录本身不是 import package；Hatchling 声明 `lxeskill`、`services`、`shared`、`browser_auth_service` 四个包。源码安装使用当前 checkout 的 `.venv`，无需手工传递 `PYTHONPATH`。`test:py-tools` 同时覆盖 Python 测试与 Skills 自带测试。

`packages/agent` 只保留 TypeScript Runtime，桌面将当前源码构建的 Python wheel 安装到私有解释器中，见 [打包手册](../desktop/packaging-pipeline.md)。模块契约进入 `harness`，独立决策进入 `record`，导航与维护规则见 [文档入口](../README.md)。

## 明确不做

- Python 闭包不额外套一层 `src/`，不修改四个公开 Python package 名称。
- 不迁移存量 env 键名，只约束增量。
- 2026-07-14 的 TS workspace 布局记录已被 Desktop 产品结构取代，当前入口见 [Desktop 技术手册](../desktop/README.md)。
