# 越南备货稀疏 SKU 映射交接

- 分支：`codex/vietnam-clean-pr6-sparse`；worktree 由 `scripts/wt-claim vietnam-clean-pr6-sparse` 领取。
- 基线：新 PR5 `124d43faa445375d1be7bf0185b04511a6fdbe37`。
- 内容：允许有效 SKU 映射表不覆盖本轮全部 SKU，已有映射行的价格可逐项为空；每个本轮 SKU 仍进入五表，仅留空缺失输入及依赖的备货/财务结果。显式零与缺失严格区分。结果校验复核条件公式及应空/应有数值的缓存。
- 文件：本目录 `asset-contract.md`、`current-sku-map.md`、本交接页，当前 Skill catalog 文档和 Vietnam Skill；`docs/superpowers/specs/2026-10-04-vietnam-partial-sku-mapping-design.md`；`python/lxeskill_cli/services/vietnam_replenishment/{asset_contract.py,formula_dependencies.py,recalculation.py,sku_map_store.py,workbook.py}` 及对应测试。
- 调用链：受信 SKU current → 原在线来源 Workflow → 精确 SKU 左连接 → 条件公式写表 → `shared.office` → 稀疏结果校验 → 最终 XLSX。本层无新环境变量，不改雅仓请求实现。
- 验证：仓库根运行 `uv run --frozen --no-sync pytest -q python/lxeskill_cli/tests/vietnam_replenishment`，217 passed、4 skipped；SKU 管理/推荐 CLI 与资产入口 28 passed；Bun Skill 13 passed。跳过项需要宿主 Office Kit 路径；单元与合成回归通过，未调用生产雅仓。
- 已知边界：没有映射行时不会猜测备货量或价格；空映射表、坏表、缺雅仓必需来源仍失败。真实 Office Kit 混合 SKU 集成在当前环境未验证，不得称为通过。
- 依赖与下一步：新 PR7 基于本层接聊天附件绑定和 Skill 预选。完整映射场景的通用结果校验已前移到新 PR3，本层只负责缺项语义。仅本地提交，未 push 或创建新 PR。
