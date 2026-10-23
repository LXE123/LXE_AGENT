# 仓库结构契约（2026-07-14）

`python/lxeskill_cli/tests/infra/test_repo_structure.py` 把本记录中的规则固化为测试。修改冻结集时，先在本目录新增一条带日期的决策记录，再扩测试里的白名单。

## 三条原则

1. **按运行时世界分区**：目录第一层只回答"属于哪个世界"——TypeScript 应用与包（`apps`/`packages`）、Python LXE Skill CLI 闭包（`python/lxeskill_cli`）、技能资产（`skills`）、配置与装配（`config`/`scripts`）、文档（`docs`）。当前模块职责与协作关系见 [架构简介](../architecture/README.md)。
2. **代码、配置、状态、文档四分离**：程序状态放入应用数据目录，模型产物放入所选工作区。数据位置由 [程序与用户数据](../desktop/data-location.md)维护，产物规则见 [权限与工作区专题](../harness/runtime/permission-policy.md)。
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

本记录早期使用的“安装目录 `var`”和全局产物目录已被后续数据目录分离与工作区产物方案取代。`LXE_DATA_ROOT` 表示应用实际数据目录，Desktop 解析后向所需子进程传递该绝对路径；当前默认位置、配置及旧目录迁移见 [程序与用户数据](../desktop/data-location.md)。

数据库布局见 [本地数据与存储](../storage/README.md)，配置和日志分别见 [桌面配置](../desktop/README.md#桌面配置与安全)及 [日志与诊断](../logging.md)。产物使用所选工作区的 `.lxeagent/artifacts/`，执行路径与写入限制见 [权限专题](../harness/runtime/permission-policy.md)。

业务模板由桌面上传并登记到 catalog 的 `input_assets`，保存于 `<data-root>/inputs/<slot>/current/`，保留一个 `previous/` 版本。仓库不再设 `data/` 模板目录，不通过手工向源码目录复制 Excel 配置业务。

## 运行时布局

Python 实现与测试集中在 `python/lxeskill_cli/`，容器目录本身不是 import package；Hatchling 声明 `lxeskill`、`services`、`shared`、`browser_auth_service` 四个包。源码安装使用当前 checkout 的 `.venv`，无需手工传递 `PYTHONPATH`。`test:py-tools` 同时覆盖 Python 测试与 Skills 自带测试。

`packages/agent` 只保留 TypeScript Runtime，桌面将当前源码构建的 Python wheel 安装到私有解释器中，见 [打包手册](../desktop/packaging-pipeline.md)。模块契约进入 `harness`，独立决策进入 `record`，导航与维护规则见 [文档入口](../README.md)。

## 明确不做

- Python 闭包不额外套一层 `src/`，不修改四个公开 Python package 名称。
- 不迁移存量 env 键名，只约束增量。
- 2026-07-14 的 TS workspace 布局记录已被 Desktop 产品结构取代，当前入口见 [Desktop 技术手册](../desktop/README.md)。
