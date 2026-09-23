# Task 2 交接：马帮巴西海外仓状态同义词契约

## 开始位置

- 目录：`/Users/hym/Documents/ChatGPT/项目合并/LXE_AGENT-integration`
- 分支：`feature-amazon-replenish-multi-platform`，不得切换到 `main`。
- 基线提交：`8a129cb7` (`fix: converge yacang warehouse intent contract`)。
- 未 push。不新建 Worktree/Pool/目录，不改管理员授权、平台账号、Token、生产开关或密钥链。

## 阶段目标

只收敛马帮巴西海外仓的自然语言契约与 canonical enum，不新增全局解析器、Runtime 关键词路由或第二个 Skill。继续使用现有 `replenishment-workflow-map` 和 `lxeskill replenish brazil-overseas export`。

| 用户表达 | 唯一 `export_kind` |
| --- | --- |
| 库存、销量、库存动销 | `inventory_sales_snapshot` |
| 单据、调拨单据，未指定签收状态 | `allocation_both` |
| 未签、未签收、待签、待签收、还没签收、尚未签收 | `allocation_pending_default_3m` |
| 已签、已签收、已经签收、签收完成 | `allocation_signed_before_3m` |

裸词“签收”、“调拨”、不能确定为巴西海外仓的“单据”必须返回澄清，不得猜测。

## 允许修改的文件

- `skills/replenishment-workflow-map/SKILL.md`
- `python/lxeskill_cli/lxeskill/catalog.json`
- `python/lxeskill_cli/services/mabang/brazil_overseas/intent.py`
- `python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py`
- `python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`
- 本交接与主交接更新。

不得修改马帮认证、HTTP请求、分页、下载、工作簿生成、生产时间范围或重试/频控逻辑。

## 实施顺序

1. 先在 `test_brazil_overseas_intent.py` 写表驱动红测试：每个同义词与 canonical enum 必须同时出现于 Skill 和 catalog 文案。
2. 运行：`uv run pytest -q python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`，确认缺失短语的用例先失败。
3. 只同步 Skill/catalog 语义，保持 `validate_brazil_export_parameters(...)` 仍只接受四个 canonical enum；自然语言翻译归选中 Skill，不进 Runtime。
4. 补充模糊边界测试：只有仓库上下文已经明确时，巴西海外仓的“单据/调拨单据”才映射为 `allocation_both`。
5. 运行完整切片：`uv run pytest -q python/lxeskill_cli/tests/mabang/test_brazil_overseas_*.py python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`，再检查 `git diff --check`。
6. 更新主交接文档，精确暂存本阶段文件，提交建议为 `fix: canonicalize brazil allocation status terms`。未经用户单独确认不得 push。

## 现有验证与限制

- 雅仓 Task 1 已通过 298 项雅仓测试、332 项 catalog/基础设施测试、4 项 Runtime 测试，且已提交。
- Desktop smoke test 已验证 `http://127.0.0.1:5237/` 返回 200，但不代表任何真实第三方平台导出已验收。
- 本阶段开始前不进行真实马帮 API 调用。

## 实现结果（待提交）

- 已在马帮 Skill 和 catalog 写入完整的待签、已签同义词表，并明确 `allocation_both` 仅用于有巴西海外仓上下文、未指定签收状态的单据/调拨单据。
- 已为每个同义词、模糊裸词和 validator 边界增加测试。
- 只修改合同说明、测试和 validator docstring；未修改任何马帮导出执行逻辑。
- 验证：完整巴西海外仓切片 `51 passed`；catalog/基础设施 `332 passed, 4 warnings`；Runtime catalog `4 pass`；`git diff --check` 通过。不含任何生产 API 调用。
- 待用户确认后精确暂存以下实现文件及交接/计划更新：`skills/replenishment-workflow-map/SKILL.md`、`python/lxeskill_cli/lxeskill/catalog.json`、`python/lxeskill_cli/services/mabang/brazil_overseas/intent.py`、`python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py`、`docs/superpowers/handoffs/2026-09-21-business-contract-convergence.md`、`docs/superpowers/handoffs/2026-09-22-task-2-mabang-brazil-status-contract.md`、`docs/superpowers/plans/2026-09-21-business-contract-convergence.md`。
