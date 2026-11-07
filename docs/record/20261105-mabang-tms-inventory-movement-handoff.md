# 马帮 TMS 原字段与库存动销汇总交接

## 工作区与范围

- Worktree：`/Users/hym/PycharmProjects/LXE_AGENT1/.worktrees/pool-20`
- 分支：`codex/mabang-tms-fix`
- 开发基线：`c27a70fc840b66086de836cd8a11df0e29c9c858`（当时 fetch 的 `origin/main` 快照）。实现提交：`43c43609`。
- PR 依赖：无；本分支只包含 TMS 修复，不依赖后续功能。
- 本轮从 pool-18 未提交改动中拆出 TMS 内容；pool-18 原文件未移动或修改。

## 已确认的行为

- 保留原 TMS XLS/XLSX 字段与列顺序，同仓同 SKU 汇总为一行。
- 按入库时间选最新一整行作为其余原字段；有效日期优先于空日期，同时间取首次出现行。多条记录出现无法识别的非空日期时失败。
- “可用库存”以列表 API `stockQuantity` 按同仓 SKU 求和，替换原 `availableinventory` 值；7/15/30 天销量分别采用 `sale1`/`sale2`/`sale3` 首个非空值，不相加。
- `all` 覆盖当前账号可见全部仓库，按实际仓库分别生成文件，不跨仓合并或根据名称推断国家。
- 非空无效数值、布尔值、NaN、Infinity 导致失败；空值按 0，负数保留。错误保留实际字段、值与转换异常，经现有 workflow 脱敏反馈。

## 修改文件与入口

- `python/lxeskill_cli/services/mabang_tms/workbooks.py`：合并原行字段与机器人库存/销量汇总，校验数值与日期。
- `python/lxeskill_cli/services/mabang_tms/workflow.py`：按仓库发布结果，并在汇总错误时失败。
- `python/lxeskill_cli/tests/mabang_tms/test_mabang_tms_export.py`：TMS workflow 与工作簿回归。
- `python/lxeskill_cli/lxeskill/catalog.json`：更新 TMS 命令与 dataset 描述。
- `skills/mabang-tms-products-export/SKILL.md`、`skills/southeast-asia-replenishment-workflow-map/SKILL.md`：说明本层 TMS 输入、口径、范围与交付。

入口仍为 `lxeskill mabang-tms products export --warehouse PH1|VN1|all`。列表分页取记录 ID，平台导出经既有覆盖校验后，结合列表 API 汇总生成各仓文件。命令契约和凭据接线未改变。

## 验证与限制

从 pool-20 仓库根目录实际运行：

- `UV_CACHE_DIR=/private/tmp/mabang-tms-fix-uv-cache uv run --frozen pytest python/lxeskill_cli/tests/mabang_tms/test_mabang_tms_export.py -q --tb=short`：**204 passed**。
- `UV_CACHE_DIR=/private/tmp/mabang-tms-fix-uv-cache uv run --frozen pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra -q --tb=short`：沙箱内首次运行受本地 HTTP 端口绑定限制；沙箱外重跑 **411 passed, 4 skipped**。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：**4 passed**。
- 未登录 TMS、未访问生产 ERP。真实 TMS 导出与生产文件验收为 **NOT VERIFIED**。

已知业务边界：`source_row_count` 是通过校验的原始表行数，`row_count` 是合并行数；Excel 不含接口记录 ID，现有 SKU/仓库与行数检查是覆盖下界，不证明逐 ID 内容完全对应。`all` 依据账号本轮实际返回的仓库，不代表账号仓库清单。

## Git 状态与下一步

- 实现、回归测试和 catalog 已作为 `43c43609`（`feat(mabang-tms): merge robot inventory totals into original exports`）单独提交。Skill、导航和本交接作为独立文档提交。
- 本分支仍未 push、创建 PR 或访问生产；真实导出验收保持 **NOT VERIFIED**。
- TMS 开发基于 main 且无代码依赖；按用户约定，主仓库 review 顺序为雅仓登录 → TMS → 菲律宾。提审时核对当时的 `origin/main` 与兼容性，不机械同步基线。

## 后续审查（2026-11-06）

- 使用已有 requesting-code-review 和 simplify 能力复查 TMS 改动，未访问生产。后续 SKU 空格处理与覆盖校验已纳入实现提交。
- 用户确认同仓 SKU 首尾空格不影响商品识别，`A` 与 ` A` 作为同一商品汇总。已将前置覆盖校验与汇总口径统一为去除 SKU 首尾空格，保留按仓库和数量的覆盖检查；空白 SKU 直接报错，避免记录被跳过。新增离线回归覆盖来源格式不同、汇总结果、跨仓隔离和缺行拒绝。
- 最终 TMS 定向测试 **204 passed**；契约测试 **411 passed, 4 skipped**；Bun 命令适配 **4 passed**。沙箱内契约测试因本地 HTTP 端口权限受阻，沙箱外重跑通过。
- 同一 SKU 首条销量为纯空格、后条为 8 时目前输出 0；此前未发现生产数据出现此情形，口径仍待明确，本轮未修改。
- pool-18 仍保留其原始混合工作区，未删除或移动其中 TMS/菲律宾文件；pool-20 的 TMS 分支可单独审查。

## 2026-11-06：三分支代码审查补充

- 在 pool-20 的 `codex/mabang-tms-fix` 使用 requesting-code-review 和 simplify 审查：同一指定仓库若返回多个仓名，拒绝覆盖交付文件；输出失败时在关闭客户端前脱敏；校验后续销量数值；多仓发布中途失败时将已完成文件标记为部分导出，标记失败则不交付未标记文件。
- 改动位于 `services/mabang_tms/workbooks.py`、`workflow.py` 和 `tests/mabang_tms/test_mabang_tms_export.py`；命令入口、凭据配置及环境变量不变。工作区根目录执行 TMS 测试 **208 passed**，仅本地模拟，无生产请求；真实导出仍为 **NOT VERIFIED**。
- 以 pool-18 未提交工作区为基础，在 `/private/tmp/lxe-branch-review-7xtiduk7` 临时副本覆盖 pool-19、pool-20 本轮相关代码及测试，独立创建虚拟环境后运行三组测试：**368 passed**。这是离线组合验证，并非分支同步。
- 纯空格销量后接有效销量的历史口径仍待确认，本轮未更改。本轮修复和交接未暂存或提交；pool-18 尚未同步这些新修复。后续按雅仓 → TMS → 菲律宾顺序评审，先将修复归位，再回归下游；提交、推送和 PR 分别遵守用户授权。

## 2026-11-06：测试精简复核

- 按用户要求使用 simplify 和 test-audit 审查，删除两个已由完整工作流测试覆盖的弱测试，以及一个由 CLI 默认范围测试覆盖的重复参数；测试声明 69→67，收集用例 208→205。安全边界和部分失败契约保留；没有新增生产代码改动，未强行达到约 20% 精简目标。
- 本工作区 TMS 测试 **205 passed**；覆盖率前后均为行 448/484（92.56%）、分支 172/204（84.31%），逐文件覆盖数无下降。均为本地模拟，真实 ERP 未验证。保留测试及审查记录见 `/private/tmp/three-branch-test-audit-20261106.md`；未暂存或提交。

## 2026-11-06：PR 准备复核

- 本轮 TMS 定向回归 **205 passed**，lxeskill/infra 契约测试 **411 passed、4 skipped**，Bun 命令适配测试 **4 passed**，Skill 兼容校验通过；使用独立临时快照将本分支最新 TMS 代码与雅仓、菲律宾代码及当前 main 的不重叠更新组合，三组测试 **363 passed**。本轮未改 TMS 生产代码、未访问生产 ERP，正式分支尚未同步。
- 历史真实联调下载出现 `SSLEOFError`；签名下载链接可否重复 GET 及异常根因未确认，未猜测重试语义。既有未提交修复及交接待授权后归位；review 仍按雅仓 → TMS → 菲律宾顺序。

## 测试占比复核

- 用户要求测试代码不超过功能及测试代码合计的 30%。按相对本分支基线的新增行计算，功能 155 行不变，测试 256→229 行，占比 62.3%→59.6%；未达到 30%，还需减少至少 163 行，现有审查未证明可以不丢失独有契约。
- 将 SKU 空格与跨仓汇总、无效数字与脱敏、两种发布失败测试合并，保留各自断言。覆盖率前后行 92.56%、分支 84.31%，逐文件无下降；本工作区 **204 passed**。SKU 空格归一化的隔离变异验证能被保留测试捕获；备份与核对见 `/private/tmp/lxe-audit30-backup-lvkf4y2u` 和 `/private/tmp/three-branch-ratio30-audit.md`。

## 2026-11-07：提交前复核

- 用户授权提交当前分支改动。TMS 定向离线测试 **204 passed**，`git diff --check` 通过；未访问生产 ERP。
- 签名下载链接的重试语义和真实完整导出仍为 **NOT VERIFIED**。下一步由用户分别决定是否推送及创建 PR；菲律宾分支的旧联调副本需在上游修复归位后整理与回归。

## 2026-11-07：多仓文件名修复与批准后的精简

- 分支 `codex/mabang-tms-fix`，pool-20，本轮修复基于 `211fe7c5`。原写文件循环每次同时预留正常名和部分导出名，按 NFC 与大小写折叠检查冲突。第三仓写入失败时，前两仓即使分别名为 `PH1` 和 `PH1-部分导出`，也不会相互覆盖。
- 回退改用普通 `Path.rename`，删除此前补丁的硬链接依赖及预计算仓名表；重命名前只检查一次目标是否已存在。目标存在或重命名失败时保留实际错误和原文件，不交付未完成标记的文件。该检查不提供外部进程并发写入的原子保证；本轮未增加此类防御。
- `merge_inventory_export` 复用 `read_workbook → coverage` 的前置保证，删除重复的表头、SKU、仓库和覆盖集合检查。保留 SKU 去空格、所有实际数值转换、日期选择及仓库 ID 歧义检查。
- 修改 `services/mabang_tms/workflow.py`、`workbooks.py`、`tests/mabang_tms/test_mabang_tms_export.py` 和本交接。入口仍为 `lxeskill mabang-tms products export --warehouse PH1|VN1|all`；凭据环境变量仍为 `LXE_MABANG_TMS_ACCOUNT` / `LXE_MABANG_TMS_PASSWORD`，命令契约不变。
- 在 pool-20 仓库根目录运行 `UV_CACHE_DIR=/private/tmp/mabang-tms-fix-uv-cache uv run --frozen pytest python/lxeskill_cli/tests/mabang_tms -q --tb=short`：**209 passed**。真实工作簿用例覆盖三仓碰撞、反向命名、大小写、Unicode、目标已存在和重命名失败。另以 I/O 故障注入模拟硬链接不可用、第二仓写入失败，验证结果为 `partial_success`，第一仓工作簿存在且内容对应，未调用硬链接。独立只读复核未发现新增问题。
- 本轮未访问生产系统。真实 TMS 导出、Windows 与 exFAT 文件系统实际运行为 **NOT VERIFIED**；故障注入不替代这些环境验收。
- 独立复审未发现新增必修问题；已检查 diff、`git diff --check`、敏感信息及 Git 状态。用户已批准暂存、提交上述四文件，补丁与本交接放在同一提交；代码与 209 项测试通过时一致。push、PR 及 merge 分别申请授权。菲律宾 pool-18 仍使用旧联调副本，待前序修复归位后整理并回归；主仓库 review 按雅仓 → TMS → 菲律宾顺序。
