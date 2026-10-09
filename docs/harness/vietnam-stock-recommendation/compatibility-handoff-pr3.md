# PR3 七参数兼容交接

2026-10-08，按已获准的 `2026-10-08-vietnam-convergence-design.md` 收敛参数 Contract。本页补充历史 `handoff-pr3.md`，不改写历史验收记录。

- Pool / 分支：`pool-9` / `codex/vietnam-clean-pr3-workbook`。
- 编辑前 HEAD：`15d5cf6e844a4159a60d644dc7c29e59f6f8424b`；编辑前工作区干净。
- 原样备份：`/private/tmp/lxe-vietnam-pr3-parameters-20261008`，含七个原文件及 `sha256.json`。
- 本层只改参数、骨架 S 公式及其校验；不改来源语义、U/W 既有修复、稀疏映射规则、CLI、Desktop 设置或 Git 状态。

## Contract 与调用链

`RecommendationConfig` 直接使用七个字段；旧字段尚未发布，不提供迁移或别名。`validate_recommendation_config(config)` 返回七个 Decimal，顺序固定对应 `数据更改!A2:G2`。

| 列 | 字段 | 表头 | 默认值 |
| --- | --- | --- | --- |
| A | `day_adjustment_30d` | 30天 | 0.8 |
| B | `day_adjustment_15d` | 15天 | 0.8 |
| C | `day_adjustment_7d` | 7天 | 0 |
| D | `exchange_rate` | 汇率 | 3900 |
| E | `sales_weight_30d` | 30天销量权重 | 0.1 |
| F | `sales_weight_15d` | 15天销量权重 | 0.3 |
| G | `sales_weight_7d` | 7天销量权重 | 0.6 |

七个值复用现有 `_number` 的有限、非负、15 位有效数字及精确 Excel 数值往返规则；汇率必须大于零。三项销量权重以 Decimal 精确合计为 1，不使用 float 容差；增加求和所需精度以拒绝 `1 + 1E-100` 被舍入成 1。

`generate_vietnam_workbook()` 入口签名保持不变，依次加载 SKU、调用 writer、既有 `shared.office`、结果 validator，然后发布最终文件。writer 和结果 validator 共用七参数 validator。结果检查要求 A:G 仍为与本轮配置一致的数值字面单元格，AV:AY 重算缓存也必须是数值；数字文本、替代公式、改值都会失败。

S2 改动前：

```text
=K2*0.1/(30+AV2)+L2*0.3/(15+AW2)+M2*0.6/(7+AX2)
```

S2 改动后：

```text
=K2*数据更改!$E$2/(30+AV2)+L2*数据更改!$F$2/(15+AW2)+M2*数据更改!$G$2/(7+AX2)
```

下行仅平移 K/L/M 与 AV/AW/AX 行号，E:G 始终绝对引用第二行。AV:AY 继续固定引用 `数据更改!A2:D2`。骨架生成器继续审核原始模板的表头/公式 SHA 指纹，然后应用上述获准公式和新增 E:G；不放宽原模板审核。

## 修改文件

- `python/lxeskill_cli/services/vietnam_replenishment/workbook.py`
- `python/lxeskill_cli/services/vietnam_replenishment/recalculation.py`
- `python/lxeskill_cli/services/vietnam_replenishment/resources/skeleton.xlsx`
- `scripts/build-vietnam-skeleton.py`
- `python/lxeskill_cli/tests/vietnam_replenishment/test_workbook.py`
- `python/lxeskill_cli/tests/vietnam_replenishment/test_recalculation.py`
- `python/lxeskill_cli/tests/vietnam_replenishment/test_skeleton.py`
- 本交接页。

## 验证证据

全部命令从 pool-9 仓库根使用其自身 `.venv`，`UV_CACHE_DIR=/private/tmp/lxe-pr3-uv-cache`；无生产请求、服务启动、客户工作簿或凭据读取。

1. 新契约红测：`uv run --frozen --no-sync pytest python/lxeskill_cli/tests/vietnam_replenishment/test_workbook.py python/lxeskill_cli/tests/vietnam_replenishment/test_skeleton.py python/lxeskill_cli/tests/vietnam_replenishment/test_recalculation.py -k 'config or sales_weight'`。实际 22 failed、2 passed、74 deselected，退出码 1。失败证实旧 Config 缺字段/缺 validator。完整输出与真实退出码分别保存在 `/private/tmp/lxe-pr3-seven-parameters-red.log`、`.exitcode`。
2. 用编辑前备份的无数据骨架作为非客户输入运行 `uv run --frozen --no-sync python -B scripts/build-vietnam-skeleton.py --source /private/tmp/lxe-vietnam-pr3-parameters-20261008/python/lxeskill_cli/services/vietnam_replenishment/resources/skeleton.xlsx`，成功，退出码 0。日志 `/private/tmp/lxe-pr3-seven-parameters-build.log`、`.exitcode`。
3. 最终定向回归：`uv run --frozen --no-sync pytest python/lxeskill_cli/tests/vietnam_replenishment/test_workbook.py python/lxeskill_cli/tests/vietnam_replenishment/test_skeleton.py python/lxeskill_cli/tests/vietnam_replenishment/test_recalculation.py`，实际 **98 passed，0 skipped**，退出码 0；日志 `/private/tmp/lxe-pr3-seven-parameters-green.log`、`.exitcode`。覆盖默认及自定义七参数、权重精确合计、数值边界、第二行绝对引用、参数篡改、数值文本、骨架隐私、既有 U/W/输出失败规则。
4. 用 openpyxl 比较原/新骨架的所有单元格值与样式，实际只有主表 S2 及 `数据更改!E1:G2` 七格变化，U2/W2/AV2:AY2 保持一致；记录 `/private/tmp/lxe-pr3-seven-parameters-resource-review.json`。原资源 SHA-256 为 `3e70bbc30ceb9450fc53ad0eb092ed0f23da6ae8ac5c4b1596b6e2a8cc40cca3`；新资源为 `b76101f2dd334193e319eda4a49aed8d7b8019a9322277fa2bc1d4ea40c11cb6`。
5. `git diff --check` 实际通过；完整修改文件 SHA、测试日志 SHA、文本 diff 与 Git 只读状态保存在 `/private/tmp/lxe-pr3-seven-parameters-review/`。通过最终 98 项回归后，生产代码、资源及测试未再修改，仅新增本交接页。

## 后续层实际影响

- PR4：已有 `generate_vietnam_workbook(..., config=...)` 签名不变；`test_workflow.py` 的旧 `weight_30d` 构造必须改为 `day_adjustment_30d`。来源读取/身份校验与导出 Contract 不因本次参数变更而改变。普通计算入口取得七参数后直接调用本层 validator/writer，不复制本层实现。
- PR5：当前 `configuration.py` 的 `CONFIG_ENV_NAMES`、四字段 overrides/defaults/field_sources 与配置测试需归位为七字段及已批准的唯一 Desktop 设置来源。`FrozenRecommendationConfig.config` 和 `PreparedVietnamInputs.configuration` 都直接携带该 Config，结构无需另加 receipt；freeze 序列必须调用本层完整 validator，以保证权重合计。配置 hash 若由单次计算快照需要，应在 PR4/5 配置冻结层生成，本层不新增持久状态或 hash 框架。PR5 将数值规则提取到 `numeric_contract.py` 的既有改动必须保持同一实现；合并时保留本层新的七参数 validator，不覆盖为旧四参数版本。
- PR6：稀疏 writer/validator 内仍引用旧字段的参数部分及测试缓存需相应更新；其缺行/缺价格与显式零规则保持。其公式守卫、来源语义和 U/W 规则不在本次修改范围，待前层依赖进入后做定向回归。
- PR1/PR2：模板 A:D 原始审核、SKU 表结构和来源语义不变，不需要接口迁移。

## 限制、依赖与下一步

- **NOT VERIFIED**：真实 Office Kit 的七参数计算缓存、ERP 导出、Windows 安装版。本次 cached-result fixture 为合成缓存，只验证保存结果与 Contract 的检查，不能替代真实 Office 数值验收；未以目录/路径信息声称来源新鲜。
- 不新增环境变量。真实 Office 仍依赖宿主 `LXE_OFFICE_NODE`、`LXE_OFFICE_CLI`；本次未配置或调用真实 Kit。
- PR3 依赖既有 PR1/PR2。本轮未修改其他 Pool；未执行 add/commit/push/PR/merge 或任何 Git 历史/状态修改。
- 当前仅七个已跟踪文件修改和本交接页未跟踪。本地 review 通过后，单独取得用户对 PR3 提交及 PR4 更新依赖的 Git 操作批准；禁止直接将这些生产文件复制进后层。
