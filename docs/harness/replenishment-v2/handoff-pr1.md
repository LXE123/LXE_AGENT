# PR1：Amazon V2备货公式交接

## 职责与依赖

- 分支 `codex/final-restock-formulas`，pool-3，确认HEAD `979c33e8`；上游为原main，PR2继承本层。PR #101。
- 本层仅有公式模块、公式测试和本交接；取数、配置、工作簿、CLI及Skill由后续层负责。
- 当前入口：`services.mabang.amazon.fba.replenishment_v2_formulas.replenishment_v2_formulas(row_number, *, peak_boost_enabled=True, peak_boost_days=None)`。模块及函数由PR4统一命名，公式逻辑仍继承本层。
- 返回I/J/R/S/U/V/W/X/Y/Z/AA/AB/AC/AI共14个带`=`的公式，供PR2写表。V1旧算法独立保留。

## 有效决策

- 行号为2～1048576的整数。AI为`(R+T+Y+AB)/J`；J为空或0留空，Y/AB空字符串按0。
- U按已确认IF顺序：S≤40急发，40<S≤70空运；S>70且J>5分支判断海运或空运＋海运。
- AA在V或W为空时留空；AC在AB或AD为空时留空，否则相乘并保留真实0。非法非空输入仍暴露错误。
- 旺季天数0～120，备注优先级及120天上限保留。公式辅助函数保留历史默认参数；正式V2生成器使用页面保存值、本轮聊天要求优先，始终显式传入解析后的开关和天数。开启缺天数时失败，不补默认30天；现行规则见[PR4交接](handoff-pr4.md)。
- 不另写一套Python数值算法。源值合法性和文件生命周期由调用方负责；空海运公式未增加AG扣减。
- 规则来源：`YHQUS转换规则.md` SHA256 `69082a327d4395ac6ef7afa50b7e40b485affc13a0b554d47706dc5f3d518165`及2026-10-13用户确认的AA/AC规则；公式更正归位PR1。

## 关键验证证据（历史，不是本轮重跑）

| 对应版本／范围 | 实际证据 |
|---|---|
| 14字段归位修复 `2ee6fb19`，后续包含于979c33e8 | pool-3自身uv环境，公式测试159 passed、无skip，含真实LibreOffice重算及AI边界。 |
| AA/AC空值修复阶段 | 新用例在旧公式失败，修复后136 passed；原34列／13公式样本26039个公式文本差异0，仅证明当时文本一致，不能替代现行35列验收。 |
| 原V1算法 | 旧公式表及计算服务定向69 passed；本层没有修改V1业务模块。 |

命令从仓库根运行：`uv run --frozen --no-sync pytest python/lxeskill_cli/tests/mabang/test_replenishment_v2_formulas.py -q -rs`。
环境须为当前checkout独立`.venv`；缓存变量只用于测试。LibreOffice缺失时重算项会skip，必须标记NOT VERIFIED。

## 当前边界与追溯

- Microsoft Excel原生计算、Windows、生产ERP、真实模型与附件发送仍NOT VERIFIED；本层无交付命令。
- PR2复用本函数及既有Office执行能力；公开公式契约变化应先修复归位本层，再复核下游。
- 早期13公式／34列和逐轮Git操作记录已压缩；完整原文可用`git show b892ea8f:docs/harness/final-restock-recommendation/handoff-pr1.md`追溯。
- 本文在PR4工作区维护；PR1分支及提交历史不改。PR4已统一模块和测试命名，公式计算规则及原验证证据保留；现行验证与未验证范围见[PR4交接](handoff-pr4.md)。
