# 越南备货 Workbook 与 Office 交接

- 分支：`codex/vietnam-clean-pr3-workbook`；worktree 由 `scripts/wt-claim vietnam-clean-pr3-workbook` 领取。
- 基线：新 PR2 `aa741c9e86d8bf11b4c9bcdb01b79bbced0ef5c4`。
- 内容：从全新工作簿构造不含历史业务数据的五表骨架；将同一轮已校验来源和运营映射表写入骨架；调用既有 `shared.office` Kit 重算；校验通过后原子交付最终 XLSX。此层不调用雅仓，也没有聊天或 CLI 入口。
- 文件：`pyproject.toml`、`scripts/build-vietnam-skeleton.py`、`python/lxeskill_cli/services/vietnam_replenishment/{resources/skeleton.xlsx,workbook.py,recalculation.py}`、三份对应测试；本目录 `pr3-workbook-design.md`、`asset-contract.md`、`current-sku-map.md`、本交接页。
- 调用链：`generate_vietnam_workbook(map_path, output_path, sources=..., config=...)` → `load_sku_parameters()` → `write_vietnam_workbook()` → 内置骨架 → `shared.office` 重算 → `validate_recalculated_workbook()` → 最终文件。无需新凭据；真实重算依赖宿主的 `LXE_OFFICE_NODE` 与 `LXE_OFFICE_CLI`。
- 验证：从仓库根运行 `uv run --frozen --no-sync pytest -q python/lxeskill_cli/tests/vietnam_replenishment python/lxeskill_cli/tests/yacang`，205 passed。全部使用合成/模拟数据，未访问雅仓生产接口。骨架隐私、Office 失败和结果校验由对应测试覆盖。后续修正中属于完整映射场景的趋势、款号及财务重算缓存检查已前移到本层，新增用例同样通过；本层也拒绝把文本 `0` 当作数值备货缓存，并覆盖短前缀 SKU 的款号边界。稀疏映射专属检查仍留新 PR6。
- 已知边界：本层要求本轮 SKU 三类来源完整、映射表显式成本和价格完整；后续稀疏映射修正属于新 PR6。旧完整模板及其历史参数不参与五表生成；真实模板仅作开发时只读参考，不入 Git。Windows 安装版由组长另行验收。
- 依赖与下一步：新 PR4 基于本层接入在线 Workflow/CLI/Skill；此层的 Office 与结果校验不得由模型跳过。本地提交，未 push 或创建新 PR。
