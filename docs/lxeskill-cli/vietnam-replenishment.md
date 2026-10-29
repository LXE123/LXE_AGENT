# 越南备货实现说明

本文只说明实现边界。取数、执行和交付步骤见 [越南 Skill](../../skills/vietnam-replenishment/SKILL.md)；命令参数与结果字段以 [CLI 契约](../../python/lxeskill_cli/lxeskill/catalog.json) 为准。已执行的文件、故障与跨平台验证见[九表验收记录](../acceptance/vietnam-nine-sheet-validation.md)。

## 计算边界

[计算流程](../../python/lxeskill_cli/services/vietnam_replenishment/workflow.py)消费三份本地雅仓报表：VN8806 库存动销、当前库存和全局产品资料。取数由独立的雅仓导出命令完成，计算不登录 ERP、不自动查找或替换输入。上架时间取产品资料的创建时间，在途数量取当前库存。

## 设置与本轮快照

应用数据目录 `skill-data/vietnam-stock-recommendation/` 只保存全局计算参数 `parameters.json`。设置页把完整九表模板保存在 `vietnam_full_workbook` 输入资产槽，并只提供“导出当前模板表”和“上传/替换模板表”两个操作。每轮计算都从模板首张「越南备货清单」提取本轮 SKU 的热销标记、成本、跨境价和折扣价。没有九表模板时明确失败；不接受独立 SKU 映射表覆盖，也不回退交付旧五表结果。

桌面设置页通过 `lxeskill vietnam replenishment settings --action read|save|upload|export` 读写参数及九表模板，使用 lxeskillCLI 的结果和错误格式。该命令是桌面内部入口，不出现在模型命令列表；Electron 不引用 Python 内部业务模块路径。

[设置模块](../../python/lxeskill_cli/services/vietnam_replenishment/settings.py)使用进程锁和原子替换：上传先校验，失败保留原文件；计算在锁内读取本轮参数。九表模板与三份 ERP 报表各自复制为本轮快照，后续修改不影响已固定的输入。文件哈希用于复核内容，不证明报表同批次或数据新鲜度。

设置页上传时先验证九张工作表及主表关键列，再保存原始文件；失败保留旧版。导出当前模板直接复制经验证的完整文件，不改保存的版本；没有已保存模板时导出按钮禁用。

只支持 Excel 1900 日期系统。设置页上传及本轮模板快照校验均拒绝 1904 模板，包括聊天显式模板和历史保存的 current；快照校验在释放设置锁后、读取雅仓报表前完成。合并入口另外比较模板与五张计算表的实际日期系统，不一致或同为不支持的 1904 时失败，不转换日期或切换工作簿标志。

## 输入校验与缺值

[模板参数校验](../../python/lxeskill_cli/services/vietnam_replenishment/asset_contract.py)按本轮来源 SKU 读取九表主表 B/E/G/AE/AJ 列。热销标记必填且只能为 1 或 2；三项金额可分别为空，非空时必须是可准确写入 Excel 的有限正数。公式价使用模板保存的计算值，未保存计算值时报错。同一 SKU 多行参数相同可用，冲突则报出行号并停止。模板中与本轮无关的历史行不参与参数校验；本轮未匹配的 SKU 按缺少整行模板参数处理。上架时间始终取 ERP 产品资料的创建时间。

缺少金额不影响备货数量，依赖它的价格、利润结果留空；缺少整行映射时，该 SKU 仍进入结果，但依赖映射的备货和财务结果留空。两种缺失不能混为一谈，空白也不等于零。

## 工作簿生成与发布

[写入器](../../python/lxeskill_cli/services/vietnam_replenishment/workbook.py)使用包内 `resources/skeleton.xlsx`，投影本轮数据并调整公式引用。开发脚本 `scripts/build-vietnam-skeleton.py` 从已审计模板提取结构、样式和公式；五表计算骨架不含真实 SKU、价格或外链。完整九表业务模板通过现有输入资产槽保存，设置页上传后成为当前模板；命令显式提供的模板只用于本轮计算，不替换当前版。本轮先复制快照，不改原文件，也不把真实商品数据放进代码仓库。

业务公式保留，权重等参数引用「数据更改」表。[重算与结果校验](../../python/lxeskill_cli/services/vietnam_replenishment/recalculation.py)通过宿主提供的 Office 运行时在临时目录执行，核对五张计算表的结构、SKU 集合、来源数据、参数、公式和计算缓存。通过后将结果合入九表模板：替换五张计算表的内容，四张业务表的工作表 XML 字节保留，最终顺序与模板一致。允许既有规则产生的负备货量；可售天数 AB 仅在日均销量为零时允许原公式的 `#DIV/0!`。

结构化结果记录本轮参数、模板来源、三份报表路径及快照哈希、校验摘要；只有最终清单进入交付文件列表。已有结果查询直接读取工作簿保存的计算结果。
