# 仓库结构契约（2026-07-14）

Status: `Current`

`tests/infra/test_repo_structure.py` 把本记录中的规则固化为测试。修改冻结集时，先在本目录新增一条带日期的决策记录，再扩测试里的白名单。

## 三条原则

1. **按运行时世界分区**：目录第一层只回答"属于哪个世界"——Bun 常驻进程（`apps`/`packages`）、前端（`web`）、Python lxeskill 闭包（`lxeskill`/`services`/`shared`/`browser_auth_service`/`tests`）、技能资产（`skills`）、配置与装配（`config`/`scripts`/`data`）、文档（`docs`）。世界内部再按领域分。
2. **代码、配置、状态、文档四分离**：运行时状态（logs、tmp、artifacts、user_session_db）不属于代码树，后续批次统一收拢进 `var/` 并整目录 gitignore。
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

## 后续批次（合并 main 后执行）

- 状态收拢：`logs/`、`tmp/`、`artifacts/`、`user_session_db/` → `var/`（触点：`packages/core/src/logging.ts` 路径拼接、`production.ts` 数据库默认路径、send_file 白名单、`.gitignore`）。
- Python 收拢：五个包移入 `python/`（触点：`lxeskill/catalog.json` 的 module 字符串、`exec-shell.ts` 守卫正则、`pyproject.toml`、全部 import）。
- docs 归类：散文件并入 `harness`（模块契约）/ `record`（决策）/ `goals` / `ops`（安装与网络笔记）。

## 明确不做

- 不做 src-layout 或全仓 Python 包改名（catalog module 字符串、守卫正则、测试 import 都是承重墙）。
- 不迁移存量 env 键名，只约束增量。
- 不动 TS workspace 布局。
