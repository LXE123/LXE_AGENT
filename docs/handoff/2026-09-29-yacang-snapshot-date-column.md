# 雅仓库存动销交付列收敛交接

- 分支：`feature-amazon-replenish-multi-platform`，实现时 HEAD 为 `0283491a`；本交接编写时尚未暂存、提交或推送。
- 结论：四平台已留存文件中，只有雅仓库存动销的“创建日期”表现为每日快照刷新时间。同一批越南仓 1,108 个 SKU 在 2026-09-23 与 2026-09-28 的该列值全部变化；其他平台的时间列及雅仓仓库产品“创建时间”保留。雅仓当前库存列表本来没有该列。
- 变更：`services/yacang/workflow.py` 下载并校验平台原件后，对库存动销创建一份只删末列的交付 XLSX；原件放在同次运行的 `original/`，不进入 `files`。最初使用 openpyxl 重存整本文件，业务人员在 macOS Numbers 中实测无法打开。现改为保留平台 XLSX 其余包成员原样，只改工作表 XML 的末列单元格、列范围和行跨度。当前库存和仓库产品仍逐字节交付原件。`created_date` 请求筛选和错误、部分成功语义不变。
- 入口／调用链：`yacang-export` Skill → `lxeskill yacang export run` → `services/agent_cli/yacang/export_run.py` → `services/yacang/workflow.py` → `artifacts[].path` → `result.files`／`send_files`。
- 配置：沿用桌面已有 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD` 注入；未新增环境变量或生产接口。
- 主要修改文件：`python/lxeskill_cli/services/yacang/workflow.py`、`python/lxeskill_cli/tests/yacang/test_export.py`、`skills/yacang-export/SKILL.md`、`skills/southeast-asia-replenishment-workflow-map/SKILL.md`、`python/lxeskill_cli/lxeskill/catalog.json` 和对应 Skill 文档。本分支原有的平台命名修改仍未暂存，勿混淆为本次去列改动。
- 初次验证：本地假平台 Python 雅仓／catalog／infra 测试 417 passed、2 skipped；其余三平台定向测试 145 passed；Bun catalog／Skill 测试 22 passed；workspace typecheck 与 `git diff --check` 通过。但这些检查没有覆盖 Numbers 打开，不能作为格式兼容验收。
- 修复验证：新增共享字符串 XLSX 包保留回归，先红（旧版丢失 `xl/sharedStrings.xml`），后绿；雅仓 fixture 测试 56 passed。对同批越南仓真实留存原件做本地处理，1,109 行、16→15 列，其余全部单元格相同；ZIP 成员相同，仅 `xl/worksheets/sheet1.xml` 内容变化，Numbers 已实际打开新文件并显示 15 列。Windows 打包相关 Bun 测试 14 passed、2 skipped，workspace typecheck 与 `git diff --check` 通过。
- 限制与发布门禁：未调用新的生产平台接口，未修改 Windows 打包器、Runtime 或其他平台。尚未在 Windows Excel／WPS 实机打开修复文件，也未进行 Windows 安装包端到端验收；不得凭 macOS 或 Python 测试宣称 Windows 发布可用。交付的库存动销不再是逐字节平台原件。仓库产品“创建时间”不应未经平台确认就称为上架时间。
- 下一步：发布前在 Windows Excel／WPS 实机打开雅仓库存动销交付件并核对行列及文件交付；macOS 本地业务测试已由用户确认通过。推送仍需单独确认。
