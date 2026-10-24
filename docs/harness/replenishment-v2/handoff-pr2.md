# PR2：35列工作簿生成交接

## 职责与依赖

- 分支 `codex/final-restock-cli`，pool-4，确认HEAD `af0d7b8b`，依赖PR1 `979c33e8`；PR #102。
- 当前`replenishment_v2_workbook.generate_replenishment_v2`接受规范店铺名及三份文件：核验MSKU源表、深圳报告、同店同日三类未关联货件快照。模块及函数由PR4统一命名，工作簿生成逻辑仍继承本层。
- 调用链：薄CLI适配→来源／店铺／批次／覆盖核验→35列`mskulist`→PR1的14公式→既有`run_kit_bounded`→结构／公式错误检查→产物发布。
- 复用原source_verification、货件loader、Office及dataset目录；不增加ERP取数、认证或第二套计算算法。
- 本层历史命令为内部能力；PR3开放业务契约，PR4将V2命令归属主Skill。当前使用指引见[PR4交接](handoff-pr4.md)。

## 当前继承能力与历史差异

- 保留全部MSKU，每行14公式；I/J及AI可供天数由Excel计算，AI显示两位小数。AD为“单件重量(g)”，空白按0，非法非空值保留MSKU和实际值诊断。
- AH取报告非空本地SKU，否则回退同源MSKU。商品类型核验结果保留，V2不套用V1过滤规则。
- 旺季页面初始关闭；本轮未指定时使用页面保存的开关和天数，本轮明确开启、关闭或指定天数优先，覆盖不写回设置。启用时须提供0～120整数天数，不补默认30天；缺值或配置损坏真实失败。运行中使用启动时读取的一份设置快照，具体契约见[PR4交接](handoff-pr4.md)。
- **af0d7b8b的AG来自uq122是历史契约；当前PR4已改为原深圳报告真实库存，取消uq122必需输入。** 不按旧文档恢复旧导出开关。
- 当前PR4的未知库存临时规则：AG空白、全部行和14公式保留，生成库存待核对文件且返回失败，暂停V2正式交付；不影响V1。

## 重要修复与原因

- `f9ef4801`归位35列、14公式、全行参与及旺季配置；PR1公式经依赖继承，不在本层复制。
- `af0d7b8b fix: preserve source text in final restock workbooks`：源字符串显式写为文本，仅设计列写公式。Office后拒绝非计算列意外公式，诊断含坐标。
- 结构／重算错误在替换正式文件前停止，已有同日合格文件不受影响。错误附件仅用于诊断。
- 三文件来源、重复MSKU、合法占位和数值边界检查各有输入职责，不复用V1会排除行的读取器代替V2全量读取。

## 关键验证证据（历史，不是本轮重跑）

| 提交／范围 | 结果与限制 |
|---|---|
| `f9ef4801`归位 | 业务定向226 passed；CLI/infra477 passed、4 Windows skipped、4既有aiohttp warnings；Bun CLI12 pass。 |
| `af0d7b8b`源文本修复 | 3个新增回归先红后绿；工作簿／CLI／A规则／设置／来源／V1共221 passed、无skip，含真实Office。 |
| af0版本历史同轮三文件离线CLI | 2002行、35列、28028公式、0 Excel错误，与此前缓存值差异0；输入及保存配置未变。该版本AG仍为uq122，不是PR4深圳库存验收。 |

日志／备份入口：`/private/tmp/amazon-restock-fixup-20261021-current-path`、`/private/tmp/pr2-literal-text-current-path`指向的目录。
从仓库根以独立`.venv`运行`uv run --frozen --no-sync pytest -p no:cacheprovider`；Office测试使用既有`LXE_OFFICE_NODE`和`LXE_OFFICE_CLI`，不共享Python环境。

## 边界、Git与下一步

- Microsoft Excel、Windows、真实模型、生产ERP及当前规则的外部附件交付NOT VERIFIED；历史文件对照不等于现行生产验收。
- PR审查顺序为PR1→PR2→PR3→PR4；前序问题修复归位，下游只继承／回归，不重新实现。
- 本历史交接仅在PR4维护，PR2分支及提交历史不改；PR4已统一模块和测试命名，底层公式和35列工作簿结构保留。早期34列、13公式、未核验行保护等已失效过程不再作执行指引。
- 完整历史与原始证据路径：`git show b892ea8f:docs/harness/final-restock-recommendation/handoff-pr2.md`；本轮验证见[PR4交接](handoff-pr4.md)。
