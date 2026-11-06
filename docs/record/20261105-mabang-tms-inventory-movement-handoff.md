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
