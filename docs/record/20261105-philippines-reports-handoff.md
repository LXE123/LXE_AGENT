# 菲律宾库存报表交接

## 范围与状态

- 功能自动调用雅仓 PH8805 库存动销、当前库存与马帮 TMS PH1 导出，合并后交付两份 XLSX。
- 原工作区 `pool-18`、分支 `codex/mabang-tms-export` 及其混合改动完整保留。菲律宾准备工作区为 `pool-21`、分支 `codex/philippines-reports-prep`；已合入雅仓 `9db4d665` 和 TMS `23f8f8cf`，菲律宾代码及共享契约的本地状态以 `git status` 为准。
- 菲律宾依赖雅仓登录态复用和马帮 TMS 每仓每 SKU 一行的汇总契约。PR 按雅仓 → 马帮 TMS → 菲律宾顺序审查；前序归位后，基于届时基线重新整理和验证菲律宾差异。

## 已确认的业务规则

- “菲律宾库存动销”“雅仓菲律宾库存”或“雅仓菲律宾销量”默认生成两份合并报表。明确要求单一 ERP、创建日期筛选或多仓时，按指定范围独立导出。
- 动销表只相加 7、15、30 天销量和可用库存；库存表只相加可用库存。其余字段保留雅仓原值；TMS 独有 SKU 没有雅仓来源的字段留空。
- 先按 SKU 合并，再分别筛选两张合并表：动销的 7、15、30 天销量全为零时过滤；库存可用量为零时过滤。空值按零处理，非零负数保留；第一张雅仓原表不筛选。
- SKU 区分大小写并保留前导零，去除首尾空格后匹配；重复 SKU、公式、Excel 错误和无效数值报错。数值使用 Decimal 计算。
- 文件名为 `菲律宾库存动销-YYYY年MM月DD日.xlsx` 和 `菲律宾库存列表-YYYY年MM月DD日.xlsx`，日期在运行开始时按 `Asia/Shanghai` 固定。工作表分别为“雅仓动销 / 合并动销”和“雅仓库存 / 合并库存”；原表内容、格式和富文本保留。
- TMS 导出自身核对分页总数与已导出记录；菲律宾流程核对仓库、汇总行数和文件行数。仅在 TMS 明确成功且来源记录、结果行和 SKU 数均为零时允许空 TMS。来源失败或部分成功时不交付合并报表。

## 文件与调用链

- `services/philippines_reports/{sources,workbooks}.py` 读取来源并合并；`workflow.py` 记录来源文件 SHA-256，核对来源数量并将两文件成对发布。
- `services/commands/philippines_reports/export_run.py` 提供命令入口，`lxeskill/{business.py,catalog.json}` 声明命令与数据集。`tests/philippines_reports/` 覆盖真实工作簿、工作流、CLI 及失败路径。
- 自动入口：`lxeskill philippines reports export` → `export_run` → `export_reports` → 雅仓 PH8805 → TMS PH1 → `_merge_files` → `build_reports`。
- `skills/philippines-reports-export/SKILL.md` 描述组合流程；三个相关导出及导航 Skill 保留单来源入口。命令手册的生成区域由 catalog 更新后重新生成。
- 凭据沿用 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD`、`LXE_MABANG_TMS_ACCOUNT`、`LXE_MABANG_TMS_PASSWORD`。数据集 ID 为 `philippines_reports`。

## 验证与限制

- 本轮精简后，菲律宾、雅仓和 TMS 定向测试 **343 passed**，其中菲律宾 **39 passed**。无关字段的非数字内容不再阻止合并；雅仓表头和仓库在导出入口检查一次，菲律宾读取时保留参与计算字段、SKU 和数量完整性检查。
- 使用 2026-11-08 用户实测的雅仓与 TMS 来源在临时目录重新生成两份报表；与原产物逐格比较内容、类型和样式，差异均为 **0**。此项不重新调用远端接口。
- `source_files[].sha256` 保留；`validation.checks` 只列实际执行的来源检查，不再声称运行时已回读校验输出。`tms_zero_or_empty_rows` 改为只按合并所用的可用库存和 7/15/30 天销量判定；该统计口径变化不影响两张报表的过滤或合并。
- 依赖合入后的工作区：雅仓、TMS、菲律宾及 lxeskill/infra 测试 **776 passed、4 skipped**；Bun 命令和 Skill 测试 **16 passed**，命令手册生成检查通过。使用本机模拟服务和测试文件。
- 合入后再次运行菲律宾调用雅仓的新鲜度联动用例：**1 passed**；旧任务已确认时获取新文件，TMS 在该用例中使用模拟结果。
- 移除手动文件入口后，菲律宾定向测试 **57 passed**；lxeskill/infra 契约测试 **415 passed、4 skipped**，Bun 命令契约 **4 passed**、通用 Skill 加载测试 **12 passed**。测试使用本机模拟服务和文件。
- 本轮菲律宾调用增加 `require_fresh=True`；菲律宾定向测试 **57 passed**。在独立快照中组合雅仓改动，使用本机模拟雅仓服务验证菲律宾调用确认旧任务后获取新文件：**1 passed**，TMS 在此联动用例中使用模拟失败结果。
- 移除手动文件入口前，pool-21 菲律宾定向测试 **71 passed**；旧依赖组合下雅仓、TMS、lxeskill/infra 测试 **720 passed、4 skipped**，Bun 命令契约 **4 passed**。
- 移除手动文件入口前，独立临时快照组合菲律宾草稿与雅仓 `f535200c`、TMS `23f8f8cf` 后，Python 首轮 **784 passed、7 failed、4 skipped**；7 项因隔离环境未安装项目导致子进程无法导入，安装项目后全部单独复测通过。Bun 命令契约 **4 passed**；未在安装项目后重跑完整 Python 套件，该结果不覆盖本轮修改。
- 两个前序依赖已合入 pool-21；菲律宾报表精简已推送至 `46be0f12`。本轮登录指引调整尚未提交或推送。
- 当前版本的真实雅仓/TMS 取数、完整生产导出和 Windows 端到端仍为 **NOT VERIFIED**。两系统不保证同一时刻的库存快照。历史联调出现过 TMS 下载 `SSLEOFError`，签名链接能否重复 GET 及异常根因未确认，不据此猜测重试策略。
- 雅仓新鲜度改动已提交并推送至雅仓分支（`9db4d665`），并已合入 `pool-21`。
- 雅仓动销接受原表或移除“创建日期”的交付版；当前库存需符合现有 18 列完整原表契约，13 列裁剪样表不能视为完整来源。TMS 来源沿用其导出读取器及错误码。

## 下一步

雅仓分支已在 `e5f48f84` 恢复共享登录 Skill 的图片识读指引，提交已推送并合入本工作区；菲律宾 Skill 已移除与之冲突的固定人工验证说明，菲律宾分支的本轮调整尚未提交或推送。

保持原混合工作区及历史改动。菲律宾报表精简已推送至 `46be0f12`；登录指引调整按用户授权提交并推送，前序 PR 审核归位后复核菲律宾差异。
