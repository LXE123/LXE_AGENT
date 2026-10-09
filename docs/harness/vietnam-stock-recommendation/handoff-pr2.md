# 越南备货来源与 SKU 准备交接

- 分支：`codex/vietnam-clean-pr2-sources`；worktree 由 `scripts/wt-claim vietnam-clean-pr2-sources` 领取。
- 基线：新 PR1 `f81b0a1bf1678456a563ca822228de2318fd261e`，并继承 main `5f78534174b76461a352bd326aabba33f2942b48`。
- 内容：复用既有雅仓 workflow 采集三类来源；验证 VN8806 来源并整理 SKU 并集；解析运营显式参数与历史模板参考；可生成运营回填表。没有最终补货生成或新公开命令。
- 文件：本目录 `current-sku-map.md`、本交接页；`python/lxeskill_cli/services/vietnam_replenishment/{yacang_sources.py,sku_parameters.py,operator_map.py,preparation.py}` 及对应四份 `tests/vietnam_replenishment/test_*.py`。
- 调用链：`export_vietnam_sources()` → 既有雅仓 workflow → `load_vietnam_sources()`；`prepare_operator_sku_map()` 可消费已有来源，或只在未传来源时采集。生产代码没有新增环境变量。
- 验证：仓库根运行 `uv run --frozen --no-sync pytest -q python/lxeskill_cli/tests/vietnam_replenishment`，83 passed。测试使用 mock/合成 XLSX，未调用雅仓生产接口。
- 已知边界：这一层的 source parser 仍位于在线适配模块；后续离线入口会把纯本地解析移出。来源报表真实性及同批次性不能仅凭本地文件证明。
- 依赖与下一步：新 PR3 基于本分支接 Workbook、Office 重算和结果校验。其他层不应绕过来源校验。仅本地提交，未 push 或创建新 PR。
