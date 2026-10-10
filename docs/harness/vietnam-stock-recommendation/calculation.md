# 越南备货实现说明

本文只说明实现边界。取数、执行和交付步骤见 [越南 Skill](../../../skills/vietnam-replenishment/SKILL.md)；命令参数与结果字段以 [CLI 契约](../../../python/lxeskill_cli/lxeskill/catalog.json) 为准。

## 计算边界

[计算流程](../../../python/lxeskill_cli/services/vietnam_replenishment/workflow.py)消费三份本地雅仓报表：VN8806 库存动销、当前库存和全局产品资料。取数由独立的雅仓导出命令完成，计算不登录 ERP、不自动查找或替换输入。上架时间取产品资料的创建时间，在途数量取当前库存。

## 设置与本轮快照

应用数据目录 `skill-data/vietnam-stock-recommendation/` 保存 `parameters.json` 和 `sku-map.xlsx`。参数由脚本自动读取，显式指定的映射表仅用于本轮，不覆盖保存的文件。

[设置模块](../../../python/lxeskill_cli/services/vietnam_replenishment/settings.py)使用进程锁和原子替换：上传先校验，失败保留原文件；计算在锁内固定参数和映射表副本后释放锁。三份 ERP 报表也各自复制为本轮快照，后续修改不影响已固定的输入。文件哈希用于复核内容，不证明报表同批次或数据新鲜度。

下载模板生成空白五列表头；导出当前表复制经过校验的完整文件，保留格式和附加工作表。两者独立于参数有效性，不改变保存的文件或更新时间；取消保存或写入失败不覆盖目标文件。

## 输入校验与缺值

[映射表校验](../../../python/lxeskill_cli/services/vietnam_replenishment/asset_contract.py)由上传、读取和计算共用。读取第一张工作表，按表头匹配；SKU 为唯一文本，热销标记必填且只能为 1 或 2，三项金额可分别为空，非空时必须是可准确写入 Excel 的有限正数。可选上架时间非空时须有效，并与 ERP 创建时间一致；计算仍使用 ERP 值。

表头有效后汇总整表可独立判断的错误，有错误则拒绝整表；坏文件保留实际异常。过长诊断提供摘要和完整报告路径，不跳过坏行或自动补值。文件限制和字段细则以校验实现及对应测试为准。

缺少金额不影响备货数量，依赖它的价格、利润结果留空；缺少整行映射时，该 SKU 仍进入结果，但依赖映射的备货和财务结果留空。两种缺失不能混为一谈，空白也不等于零。

## 工作簿生成与发布

[写入器](../../../python/lxeskill_cli/services/vietnam_replenishment/workbook.py)使用包内 `resources/skeleton.xlsx`，投影本轮数据并调整公式引用。开发脚本 `scripts/build-vietnam-skeleton.py` 从已审计模板提取结构、样式和公式；运行时不读取历史备货文件。骨架不含真实 SKU、价格或外链。

业务公式保留，权重等参数引用「数据更改」表。[重算与结果校验](../../../python/lxeskill_cli/services/vietnam_replenishment/recalculation.py)通过宿主提供的 Office 运行时在临时目录执行，核对五表结构、SKU 集合、来源数据、参数、公式和计算缓存，全部通过才发布最终 XLSX。允许既有规则产生的负备货量；可售天数 AB 仅在日均销量为零时允许原公式的 `#DIV/0!`。

结构化结果记录本轮参数、映射表来源、三份报表路径及快照哈希、校验摘要；只有最终清单进入交付文件列表。已有结果查询直接读取工作簿保存的计算结果。
