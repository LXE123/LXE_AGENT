# 越南备货输入资产契约交接

- 分支：`codex/vietnam-clean-pr1-assets`
- 本地 worktree：由 `scripts/wt-claim vietnam-clean-pr1-assets` 领取，工作目录以 `git rev-parse --show-toplevel` 为准。
- 基线：组长仓库 main `5f78534174b76461a352bd326aabba33f2942b48`。
- 本层范围：只读校验旧业务模板和运营 SKU 参数表；注册两个 Desktop 管理的资产槽，阻止通用命令直接提升这两个槽的版本。模板槽保留历史兼容，后续五表生成使用内置骨架；SKU 表是后续生成必须校验的 current 输入。
- 文件：`docs/README.md`、本目录 `asset-contract.md` 和本交接页、`python/lxeskill_cli/lxeskill/catalog.json`、`python/lxeskill_cli/services/assets/inspect.py`、`python/lxeskill_cli/shared/input_assets.py`、`python/lxeskill_cli/services/vietnam_replenishment/{__init__.py,asset_contract.py}`、`python/lxeskill_cli/tests/{infra/test_input_assets.py,vietnam_replenishment/test_asset_contract.py}`。
- 入口：`validate_template(path)`、`load_sku_parameters(path)`、`load_input_assets()` 和 `current_asset(slot_id)`。本层没有在线取数、绑定、Workbook 生成或聊天路由；不需要新增环境变量。
- 验证：从仓库根执行 Python 定向与 catalog/infra 测试，430 passed、2 skipped；Bun catalog 契约 9 passed。测试仅使用合成工作簿与本机回环测试服务，未调用雅仓生产接口。
- 已知边界：只读 parser 本身不负责建立受信 current，也不保证生成；旧模板审计入口不代表运行时依赖该模板。真实模板、SKU 参数和价格数据不得进入 Git。
- 依赖与后续：下一层在本分支之上接入雅仓来源与 SKU 参数准备；后续模块分别实现 Workbook、在线 Workflow、受信 SKU 版本、稀疏规则、聊天绑定、多附件和离线生成。每层按自身边界验证。
- Git 状态：本层仅本地提交；尚未 push 或创建新 PR。提交后用 `git status` 复核工作区干净。
