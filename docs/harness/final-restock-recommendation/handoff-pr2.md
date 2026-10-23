# 最终备货建议：PR2 实施计划与交接

## 2026-10-21 PR2 P2：源字面文本保真与非计算公式拦截

- **现场与归属**：pool-4 / `codex/final-restock-cli` 起始 HEAD `bcd4c04b`，工作区干净。P2 归工作簿生成层：openpyxl 将以 `=` 开头的源字符串隐式写成公式，原错误单元格扫描无法识别计算成功但内容已变的文本。只修改工作簿服务、对应测试和本交接 3 文件；PR1 公式、catalog、取数、认证、设置及普通备货生产实现不变。
- **最小修复**：`_write_workbook()` 沿用现有普通备货 `write_formula_sheet()` 的字符串写入方式，源字符串显式设为 `s`，随后仅由 PR1 为设计的 14 列写入公式；不增加前缀字符或改写文本内容。`_inspect_recalculated()` 要求计算列仍是真公式，并拒绝其他单元格中的意外公式，错误包含坐标；检查仍在正式文件替换之前完成。
- **失败复现与修复验证**：新增 3 项回归在旧代码上实际全部失败，分别复现所有源文本列被自动当作公式、源核验后的字面文本被真实 Office 计算，以及意外公式未阻断发布。修复后 3 项全部通过。覆盖 `=1+1`、`=2+2`、不可执行的未知函数字面文本、可能改变备注判断的 UNICHAR 字面文本；保留全部 14 列真公式。模拟插入 AE2 意外公式后经真实重算被明确拒绝，已有同日成功文件字节不变。
- **定向回归**：使用本 checkout 自身 `.venv` 和 `uv run --frozen --no-sync pytest -p no:cacheprovider` 执行工作簿、生成 CLI、A 规则、设置、来源核验/存储及普通备货服务测试，共 **221 passed，无 skip**。Office 使用已存在的 pool-7 官方 0.1.5 Node/Kit 运行文件，只读引用运行资源，不共享 Python 环境、不安装依赖或修改宿主配置。没有新增环境变量；测试进程临时注入原 `LXE_OFFICE_NODE` / `LXE_OFFICE_CLI`。
- **历史真实文件离线回归**：复制既有同轮三文件到本轮临时数据目录，经真实 PR2 CLI→Service→`run_kit_bounded`→Office Kit，生成 **2002 行、35 列、28028 公式、0 Excel 错误**；与此前已验证文件的全部缓存值差异 0，AG 1970 正数/29 真 0/3 有限负数，24 条无本地 SKU 和 1 条无库存数据合法占位不阻断，24 个未核验商品均保留完整公式。三个输入 SHA-256 与保存设置前后不变；未访问 ERP。
- **保护与同步**：本轮备份、前置状态和离线证据由 `/private/tmp/pr2-literal-text-current-path` 指向。用户已确认修复归位 PR2 后，让第三分支继承同一个 fix 提交并更新两个已提交 PR 的源分支；因此仅追加本地 fix、PR2→PR3 依赖 merge 与两分支普通 push，不重写历史、不强推、不改 main/PR1/pool-9、不创建新 PR。本层提交前复核完整暂存 diff 和 cached diff/check；PR3 在新依赖上做必要衔接回归。
- **验收边界**：本轮为可信离线数据和合成输入的真实 Office 调用链验证，不等于 Microsoft Excel、原生 Windows 或生产 ERP/模型全链验收；不修改本次无关的上游源文件生成模块。提交号及远端更新结果以最终 Git 输出为准。

## 2026-10-21 修复归位：当前工作簿契约

- 归位前 HEAD 为 `894a413e`。当前 PR2 接入 PR1 的 14 字段契约，生成 **35 列 A:AI** 工作簿，新增 AI「可供天数」，显示两位小数；AD 表头为「单件重量(g)」。以下旧 34 列、13 字段和未核验行不生成建议的描述均为历史记录。
- 所有源 MSKU 行写入全部公式，商品类型核验结论保留在源文件中；它不再作为本功能省略 U–AC 的条件，普通备货沿用原规则。
- AG 仅取 MSKU `本地库存`（`uq122`），允许真实 0、有限负数及合法数字文本；缺失、空白、非法或非有限值整表停止并报告 MSKU。深圳报告的合法占位行不单独阻断，也不向 AG 提供数值；店铺、批次、指纹、结构和 MSKU 身份覆盖仍校验。
- AH 为深圳报告非空优先、空白回退源表；不因两边 SKU 不同单独停止。AD 空白按 0，非空非法重量保留 MSKU、原字段、解析阶段及实际值诊断。库存不新增非负限制。
- 正式生成每轮默认 `peak_boost_enabled=False`，仅明确参数启用；`peak_boost_days` 可覆盖本轮天数，省略读取一次保存值，保存值为空按 30 天。现有配置校验、原子持久化和单轮快照实现一并归位本层；损坏配置明确停止。
- 内部三文件命令继续 `internal`、不绑定 Skill；仅补齐现有两个旺季参数。Desktop、设置命令、自动取数和模型入口留在最终功能 PR。本层没有新增第二套协议或计算路径。
- 工作簿服务采用已验证 pool-9 版本，包含此前两处无效异常包装的清理，原异常继续传播。相关工作簿、A 规则、设置及 CLI 测试随实现归位。
- PR1 公式服务、测试和 handoff 已通过本地 merge `20dc63ec` 继承修复提交 `2ee6fb19`，不属于本层独立修复提交范围。没有在 PR2 重复提交公式实现或重写历史。
- 本轮使用自身 `.venv` 执行工作簿、生成 CLI、A 规则、配置存储、普通备货和来源核验定向回归：**226 passed，无 skip**；`tests/lxeskill` 和 `tests/infra` 为 **477 passed、4 skipped、4 warnings**（4 skip 为原生 Windows，warning 为已有 aiohttp 提示）；Bun `lxeskill-command.test.ts` 为 **12 pass、0 fail**。没有运行无关全量测试。
- 复用已准备的 Office Kit 0.1.5，只读使用其运行文件，不共享 `.venv`。通过本层真实 CLI 对 10 月 19 日离线三文件生成 **2002 行、35 列、28028 个公式、0 个 Excel 错误**；全部缓存值与已验证候选相比差异为 0。AG 为 1970 正数、29 个 0、3 个有限负数；24 条无本地 SKU、1 条无库存数据占位不阻断，24 个未核验 MSKU 均有完整公式。保存的开关为 true/120 天时，省略本轮启用参数仍不加成；输入和配置未变。
- 新增 CLI 定向验证覆盖默认参数、明确启用/自定义天数、非法天数在读取业务文件前失败、标准终态和产物路径；命令在本层仍为内部能力。原生 Windows、Microsoft Excel、生产 ERP 和真实模型为 NOT VERIFIED。
- 完整证据及可恢复备份见 `/private/tmp/amazon-restock-fixup-20261021-current-path` 指向的目录。用户已分别批准本轮精确 add/commit 和 PR1→PR2→pool-7 本地依赖 merge；仅追加提交，不 rebase，不 push，不修改 main。pool-9 的 251 个暂存路径和 7 个未暂存文件继续原样保护。

## 原阶段目标与架构（历史，当前契约以上文为准）

交付一个独立离线 `lxeskill` 命令：读取已核验的 Msku 源文件、深圳库存报告和同店同日的未关联货件快照，保留源表全部 MSKU 行，复用 PR1 的 `final_restock_formulas(row_number)` 生成 `mskulist` 34 列 XLSX，并通过项目托管 Office Kit 重算和检查结果。

实现只增加备货业务服务、薄 CLI 适配、一个 catalog 命令及产物数据集。来源校验复用 `source_verification`、深圳库存来源字段和核验元数据、未关联货件 loader 与同日校验；文件产物遵循 `dataset_dir()`。不实现新 Skill，不改旧算法、认证、数据获取或运营输入文件。

**技术栈：** Python、openpyxl、`uv`、`shared.office.execution.run_kit_bounded()`。

**规则依据：** 2026-10-13 用户最新截图选择 XLSX 提取记录中的 AA（V/W 任一空则空）、AC（AB/AD 任一空则空，否则相乘）及 AD 表头“单件重量”，覆盖此前三项 Markdown 优先选择；其余沿用已确认规则。公式更正归 PR1，本 PR 已 rebase 接入 `70bc0568`；任何实际重算错误仍必须报告失败。

## 全局约束

- 工作分支为 `codex/final-restock-cli`，位于 `.worktrees/pool-4`，当前基于 PR1 `70bc0568`。
- Python 只用 `uv`；不访问生产 ERP，不改运营源文件。
- 保留完整源行；重复 MSKU、无法证明来源/店铺/批次一致、未知关键输入不得静默去重、分摊或当作 0。
- catalog 改动后运行 Python `lxeskill`/`infra` 契约测试和 Bun `lxeskill-command` 测试。
- 2026-10-14 最新授权：独立审核通过后本地提交 PR2，并安全同步到 PR3、保留其未提交修改。PR3 暂不 commit；不 push、merge 或访问生产 ERP。

## 文件职责

- 新建 `python/lxeskill_cli/services/mabang/amazon/fba/final_restock_workbook.py`：输入来源与批次校验、全行字段映射、34 列工作簿生成、Office 重算和错误诊断。
- 新建 `python/lxeskill_cli/services/agent_cli/mabang/generate_final_restock_recommendation.py`：薄 JSON CLI 适配，映射参数、成功结果和真实异常。
- 修改 `python/lxeskill_cli/lxeskill/catalog.json`：登记一个最小命令和对应产物目录。
- 新建 `python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py` 与 `test_final_restock_workbook_cli.py`：来源/覆盖/映射/格式/公式/错误语义与 CLI 契约。
- 本文件：记录最终改动、调用链、命令、验证证据、限制和下一步。

## 实施步骤

1. 先写服务测试，覆盖：源文件及深圳报告核验元数据必须匹配；货件快照店铺和日期必须匹配；重复或缺失 MSKU、关键未知数值拒绝；深圳报告必须覆盖全部源 MSKU，库存数值未知时留空，组合编码读取报告的 `子SKU`，缺失时回退源表本地 SKU；有效确认快照未列出的 MSKU 记为已知 0；每条源行对应一条输出行。
2. 实现唯一服务入口：用 `load_verified_source()` 取得全量源记录；直接解析深圳报告四类业务 Sheet，不调用会过滤行的 `load_inventory_rows()`；复用 `load_unlinked_shipment_quantities()` 和同日校验；按 A:AH 写入列值与 PR1 13 列公式。保持 Calibri 11、冻结 A2、自动筛选、85% 缩放及 J/S 数字格式。
3. 用 `run_kit_bounded()` 执行 `shared.office recalculate`，读取重算后的文件并统计 Excel 错误单元格。错误诊断保留到结构化 CLI 结果；若存在错误，命令结果失败并仍可交付诊断文件，不声称正式 XLSX 通过零错误验收。
4. 写 CLI 参数/成功失败测试，再登记 catalog 命令和 dataset；按仓库契约运行定向 Python 与 Bun 测试。
5. 审查所有新增文件和 catalog diff、运行 `git diff --check`、核对状态/敏感信息/无关改动，完成本交接文件；随后汇报并申请本地 add/commit。

## 最终交接

### 完成范围

- 已实现离线命令 `lxeskill replenish final-restock generate`，当前要求显式传入店铺、MSKU 源文件、深圳库存报告和未关联货件快照，共四项输入。
- 服务使用 `load_verified_source()` 读取完整 MSKU 行；要求深圳报告核验元数据与源文件批次相同，并核对深圳报告的全量 MSKU 覆盖。重复 MSKU、孤立货件 MSKU、店铺/日期不符及缺失关键数值会报错。
- 按 A:AH 写出 `mskulist`，保留每条源 MSKU 一行，复用 PR1 `final_restock_formulas(row_number)`；生成后调用 `run_kit_bounded()` 重算并检查公式保留、行列数、缓存结果和 Excel 错误单元格。
- 命令当前在 catalog 中标为 `internal`、`exposed: false`、无 owner Skill，仍可直接从 CLI 调用。PR3 的 Skill/Agent 编排与将命令开放给 Skill 路由不属于本 PR。

### 文件与调用链

- `python/lxeskill_cli/services/mabang/amazon/fba/final_restock_workbook.py`：离线输入校验、字段映射、34 列 XLSX、Office 重算和错误诊断。
- `python/lxeskill_cli/services/agent_cli/mabang/generate_final_restock_recommendation.py`：薄 CLI 适配器，保留真实异常文本。
- `python/lxeskill_cli/lxeskill/catalog.json`：命令契约与 `replenish/final_restock_recommendation` 产物目录。
- `python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py`、`test_final_restock_workbook_cli.py`：服务与 CLI 测试。
- `python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py`、`packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：catalog 契约数量与双端消费测试。
- 调用链：catalog 命令 → CLI JSON 适配器 → 备货服务 → `load_verified_source()` / 深圳报告核验信息 / `load_unlinked_shipment_quantities()` → PR1 公式模块 → `dataset_dir()` 输出 → `run_kit_bounded()` 重算与检查。

### 环境与产物

- Office 重算依赖宿主配置 `LXE_OFFICE_NODE` / `LXE_OFFICE_CLI`。本轮测试使用临时准备的锁定版本运行环境，具体路径见末节；没有修改应用宿主的持久配置。
- 成功重算后默认产物写入 `dataset_dir("replenish_final_restock_recommendation")`，文件名为 `YYYYMMDD{店铺名}补货最新.xlsx`。
- 公式错误会以坐标和真实单元格错误值返回，错误工作簿仍作为诊断产物保存，命令结果为失败。

### 初始提交验证结果（历史）

- 服务与 CLI 定向测试：`11 passed, 1 skipped`。唯一跳过项为真实 Office 端到端测试，跳过原因是 `LXE_OFFICE_NODE` 未配置。
- 复用模块回归：`184 passed`，覆盖来源核验、深圳库存、未关联快照与既有补货模块。
- 仓库要求的 Python catalog/infra 测试：`478 passed, 4 skipped, 4 warnings`。
- Bun catalog 测试：`12 pass, 0 fail, 85 assertions`。
- CLI `--help` 实际返回 `ok: true`，确认命令参数契约可加载；catalog JSON 解析、命令唯一性和数据集登记检查通过；`git diff --check` 通过。
- **NOT VERIFIED：** 此环境没有实际运行 Office 重算、没有生成最终可交付 XLSX，也未完成真实文件的零错误验收。测试中的真实 Office 端到端路径因此跳过。

### 已知限制与 PR 依赖

- AA/AC 更正已通过 rebase 从 PR1 接入；本 PR 未独立复制公式。项目 Office Kit 的离线小样本实际重算已通过，真实业务同批次输入验收仍为 NOT VERIFIED，服务继续对任何 Excel 错误返回失败并保留错误示例。
- PR2 依赖 PR1 `70bc0568`（分支 `codex/final-restock-formulas`）的 `final_restock_formulas()` 契约；PR1 handoff 位于 `docs/harness/final-restock-recommendation/handoff-pr1.md`。
- 当前没有外部 ERP/API 取数逻辑，也没有创建新 Skill。

### 初始提交 Git 状态（历史）

- 当前分支：`codex/final-restock-cli`，worktree：`.worktrees/pool-4`，基线提交：PR1 `e9b88b92`；主工作区与 PR1 worktree 未修改。
- PR2 的 8 个实现、测试与交接文件已提交为 `caef4809 feat: add final restock recommendation CLI`；没有 push 或创建远端 PR。
- 用户已批准进入下一阶段。PR3 应在新聊天窗口、专用 worktree 中，以本分支最新提交为基线继续；push、创建/更新 PR 与 merge 仍需分别取得明确授权。

## 2026-10-13 截图规则更新（同步前记录）

- 本轮只修改本 PR 的文件服务、文件测试和本 handoff（3 个文件）。AD 表头及行映射键改为“单件重量”，数值仍按克；原始输入字段、输出位置 AD、CLI/catalog 与产物路径不变。
- 正式 Office 小样本测试改为预期零公式错误，并检查清货行 AC 为空、有效海运重量仍为数量乘克数；没有放宽错误检测。该测试须在本分支接入 PR1 新公式且 Office 配置完成后实际运行。
- 本 worktree 执行 `UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache uv run --frozen --no-sync pytest python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py -q -rs`：**11 passed, 1 skipped**。通过项包括 AD 表头和 50 克源值保持；跳过真实 Office 测试，原因为 `LXE_OFFICE_NODE` 未配置。
- **NOT VERIFIED：** PR1 新公式与本 PR 的组合回归、真实 Office 端到端及最终零错误 XLSX。当前测试未伪装为已同步上游。
- Git HEAD 仍为 `afc9528f`。本轮未 add/commit、未 rebase；PR1 新公式尚未进入本 checkout。待用户批准后分别提交本层修改，再同步 PR1，复核后向 PR3 传播。

## 2026-10-13 已授权同步与 Office 回归

- 用户随后提供原始参考 XLSX 并批准分别本地提交、备份及 PR1 → PR2 → PR3 rebase。旧 PR2 HEAD `afc9528f` 已保存在 `codex/final-restock-cli-before-xlsx-20261013`，原提交和工作区均保留。
- 本层表头、测试和交接更正已独立提交并 rebase 到 PR1 `70bc0568`，无冲突。同步后更正提交为 `a2139ab0`；原 CLI / 交接提交分别映射为 `32661513` / `8028bb1e`，`git range-diff` 确认两者内容未改变。PR1 的服务、测试和 handoff 与其分支完全一致。
- 只读核验用户原件：`/Users/hym/Downloads/20261012Amazon-Yihaiqian-US补货最新.xlsx`，SHA-256 `aafdd45f445e19530c0b1f79ad650a3c6c242473e76101b9dc051a6bb811faf7`。34 个表头、2003 行的 26039 个公式均与本次实现一致；冻结 A2、筛选 A1:AH2004、缩放 85%、J 的 `0.0000` / S 的 `0.00` 格式符合约定。原件公式缓存全部为空，没有覆盖原文件。
- 按既有 `scripts/prepare-office-runtime.ts` 以 frozen 安装准备 Kit 0.1.3 / native engine 0.1.3，校验 733 个文件。没有修改依赖版本、lockfile 或共享 `.venv`。测试命令从本 worktree 根执行：

```sh
LXE_OFFICE_NODE=/Users/hym/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
LXE_OFFICE_CLI=/private/tmp/lxe-final-restock-office-runtime/office/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js \
UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache \
uv run --frozen --no-sync pytest python/lxeskill_cli/tests/mabang/test_final_restock_recommendation.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py -q -rs --tb=short
# 148 passed，无 skip
```

- 实际走文件服务 → `run_kit_bounded()` → 项目 Office Kit 重算，四行合成输入生成完整 34 列文件，公式错误数为 0；验证清货行 AC 留空、海运重量正确、完整行覆盖、组合 SKU、格式和缓存。此前因环境缺失跳过的 Office 用例本轮已实际通过。
- **NOT VERIFIED：** Microsoft Excel 原生计算、真实业务同批次 MSKU / 深圳库存 / 未关联货件完整输入集、模型自然语言入口与文件发送。参考结果表不替代业务源输入集，没有访问生产 ERP。未执行全仓库测试或 build/typecheck，留待最终合并阶段按规范处理。
- 收口记录采用本 PR 独立文档提交；最新 HEAD 以本分支 `git log -1` 为准。接下来由 PR3 rebase 接入本层并执行契约回归。main 未修改，没有 push、远端 PR 或 merge。

## 2026-10-14 重复输入收敛（首轮审核记录）

- 按用户确认删除 `shenzhen_source_msku_xlsx_path`：catalog 的 property/required、CLI 转传、服务参数及物理路径相等检查。当前输入为店铺和三个本地文件；不增加兼容别名、抽象层或新路由。
- 保留原源表内容指纹、店铺、核验快照及来源元数据比较、深圳报告 MSKU 覆盖、货件同店同日与完整性检查。未修改业务公式、旧备货服务、公共核验模块、Office 执行能力或参数来源导出服务。
- 用新契约测试先在旧实现得到 4 failed / 1 passed，失败均指向重复参数仍存在或仍被转传；更正后通过。正式 Office 文件测试使用原件的等内容复制源表，确认不再错误依赖原物理路径，同时仍保留全部行和零公式错误。
- 增补服务层店铺/源指纹拒绝用例，并将批次冲突用例覆盖到“源内容不同”和“内容相同但核验快照不同”；CLI 测试验证四项输入及旧 flag 的 `unknown option` 失败，不静默接受旧接口。
- 从本 worktree 根、使用自己的 `.venv`，设置上一节 Office 两变量、`PYTHONDONTWRITEBYTECODE=1` 和临时 `UV_CACHE_DIR` 后，执行 `uv run --frozen --no-sync pytest -p no:cacheprovider python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py python/lxeskill_cli/tests/mabang/test_source_verification.py -q -rs --tb=short`：**61 passed，无 skip**，含实际 Office Kit 重算。
- catalog 必需双端回归：Python `tests/lxeskill` / `tests/infra` **477 passed, 4 skipped, 4 warnings**（4 skip 为 Windows 专属，warning 为原有 aiohttp 提示）；Bun `lxeskill-command.test.ts` **12 pass，85 assertions**。Python 模拟服务器测试在沙箱外执行，仅访问本机测试服务器。
- 本轮只修改本 PR 的 catalog、CLI、文件服务、两份测试和本 handoff，共六个文件；diff 已检查，旧参数在活跃实现中无残留，旧 flag 仅保留于拒绝回归用例及历史记录。没有 Git 写操作。
- HEAD 保持 `797436bd`。PR3 需更新其所属 Skill、契约测试和 handoff；本轮不通过跨分支编辑或 rebase 将上游服务/目录覆盖到 PR3。组合验证需明确区别于真正分支同步，后者等待审核及新的 Git 授权。

## 2026-10-14 最终审核与授权收口

- 从 PR1 `70bc0568` 核对 PR2 完整差异，并逐项审查本轮六个文件。代码无需进一步修复：catalog、CLI 和服务均为店铺与三个文件；旧 flag 由既有参数解析器返回 `invalid_arguments / unknown option`。本次仅修正上文“缺少深圳行”表述，实际始终要求完整 MSKU 覆盖。
- `load_verified_source()` 的店铺、内容指纹、快照摘要、绑定标记和数量核验未变；深圳报告完整元数据相等、MSKU 覆盖、货件同店同日校验未变。AST 比对确认 14 个服务辅助函数均未改变，公式、原备货实现及公共核验模块无改动。
- 可删减项已落实为重复参数和路径相等检查；沿用现有 catalog → CLI → 离线服务 → Office 调用链，没有新增公共抽象、适配层、状态或 Runtime 路由。本次参数整改未发现 P0–P3 缺陷或阻塞问题。
- 正式 pool-4 根目录、本工作区独立 `.venv`，使用上一节 Office 两变量，执行 `uv run --frozen --no-sync pytest -p no:cacheprovider python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py python/lxeskill_cli/tests/mabang/test_source_verification.py python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra -q -rs --tb=short`：**538 passed, 0 failed, 4 skipped, 4 warnings**。跳过项为 Windows 路径/进程测试，warning 为既有 aiohttp 提示；实际 Office Kit 重算通过。日志：`/private/tmp/final-restock-pr2-close-python.log`。
- Bun `packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：**12 pass, 0 fail, 85 assertions**。工作差异和相对 PR1 的 `git diff --check` 均通过。
- 仅将上述六个 PR2 文件纳入 `fix: remove redundant final restock source path` 本地提交，提交号以本分支 `git log -1` 为准。PR3 后续通过依赖同步继承此修复，自身 Skill/契约/交接修改保持未提交。未执行 push、merge 或生产调用。
- 离线代码具备 Review 条件；主仓库 Review 仍按 PR1 → PR2 → PR3 串行。真实业务完整输入、Microsoft Excel 原生计算、模型选择及附件发送仍为 **NOT VERIFIED**，不将本次定向测试称为全仓库验证。

## 2026-10-15 AG/AH 字段映射修复归位

- pool-4 `codex/final-restock-cli` 的本层计算服务要求 MSKU 源表含 Amazon MSKU 列表 `uq122` 导出的“本地库存”。AG 使用该 MSKU 自身的字段，允许有限负数并区分 0 与空白；深圳报告的可用库存仍须为有限数，但不再代替 AG。AH 优先读取深圳报告“本地SKU”组合编码，缺失时回退同轮源表“本地SKU”，不再输出“子SKU”配比文本。
- 仅修改最终表服务、对应定向测试和本交接文件。店铺、批次、指纹、MSKU 覆盖及其他数量校验保持原契约；34 列和原有 13 列公式不变。PR2 接收已核验的三文件，不负责修改共享 MSKU 导出；默认导出尚不含 `uq122`，下游自动取数集成须按需提供此列。
- 在 pool-4 自身环境使用 Office Kit 运行最终表、来源核验、PR1 公式和普通备货定向回归：**254 passed，无 skip**。PR3 须同步源表“本地库存”必需列的说明，再由 pool-7 安全继承本层修复。T 列状态边界、Microsoft Excel 原生重算、生产端到端交付仍待验证。

## 2026-10-15 未绑定商品建议保护与零重量输入修复

- 以已核验源表的本地 SKU 是否为空判断是否绑定：全部 MSKU 和原始销量保留。未绑定行仅保留 I/J/R/S 分析公式，U:AC 九列运输和补货建议留空；正常绑定行仍使用原有 13 列公式。该例外与旧运营样表“全行均有 13 列公式”不同，Review 时必须明确说明。
- 同轮真实源表的 24 条未绑定商品重量均为数值 0；原有重量解析器将 0 返回空而拦截生成。本层仅把数值 0 保留为 0，仍拒绝无效重量，不改共享解析器或普通备货。重算校验会确认未绑定行建议单元格及缓存均为空。
- 本次仍仅修改 `final_restock_workbook.py`、`test_final_restock_workbook.py` 和本 handoff；不改 CLI、取数服务、Runtime、13 列公式定义或其他字段。pool-4 自身环境以 Office Kit 运行最终表、来源核验、PR1 公式及普通备货定向回归：**258 passed，无 skip**。
- 只读使用 pool-7 已保存的同轮三份真实输入在 pool-4 离线生成 `/private/tmp/pool4-pr2-port-check/20261015Amazon-Yihaiqian-US补货最新.xlsx`；未写入 pool-7、未连接 ERP。输出可读：**2002 行、34 列**，AG/AH 各 **2002/2002** 匹配；1978 条绑定行各 13 列公式，24 条未绑定行各 I/J/R/S，U:AC 共 216 格为空，合计 **25810 个公式**；24 个零重量为 0，缓存 Excel 错误 0。历史全行公式记录不适用于当前保护后的文件。
- PR2 仍为三文件离线计算入口；默认 MSKU 导出不含 `uq122`，下游自动取数需按需提供。PR3 再安全同步本层接口及未绑定公式例外，pool-7 随后继承，避免重复提交。本轮未调用生产 ERP；T 列货件状态边界、Microsoft Excel 原生重算、保护后的 Desktop 附件交付及全量测试/build/typecheck 为 **NOT VERIFIED**。

## 2026-10-15 AH 来源一致性与正式文件发布保护

- pool-4 `codex/final-restock-cli` 的修复前 HEAD 为 `ef11bbf1`。深圳报告写入“本地SKU”时直接沿用同轮 MSKU 源表的该字段（仅去首尾空白），组合商品的“子SKU”配比另列；没有已证实的合法转换或人工修改步骤。最终表读取时，报告“本地SKU”非空必须与源表一致，否则按 MSKU 明确报错；报告为空仍回退源表。已保存的同轮真实文件 2002 个 MSKU 键完全覆盖，1978 个非空值一致，24 个双方均为空，0 个不一致；“报告空白、源表非空”的回退另由定向测试覆盖。
- 重算及结构检查通过且无公式错误才替换同日正式 XLSX；公式错误工作簿保存在独立的“公式错误诊断”文件，失败结果仍返回真实错误，既有同日合格文件不受影响。深圳报告仍参与来源元数据、店铺、批次、MSKU 覆盖及深圳库存数值校验；其库存数值不再写入最终表 AG，AH 的非空值与源表一致。因此本轮不删除三文件契约，是否进一步收敛需单独确认是否仍要求实时深圳库存取证。
- 修改仅为最终表服务、对应测试和本 handoff；34 列、13 列公式、AG `uq122`、未绑定保护、普通备货及取数能力未改。pool-4 的最终表/来源/原备货相关回归 **266 passed**；pool-6、pool-7 镜像的最终表与 CLI 测试各 **32 passed**。pool-7 的同轮真实三文件在镜像代码下离线生成 **2002 行、34 列、0 公式错误**，未调用 ERP。Microsoft Excel 原生重算、T 列业务边界、保护后 Desktop 再交付仍为 **NOT VERIFIED**。
- 本层修复归属 PR2 的单个本地 `fix` Commit；pool-6、pool-7 目前只是相同未提交差异，尚未通过提交祖先关系继承。后续获授权后再顺序同步 PR3、pool-7，不在下游重复提交本层服务或测试。

## 2026-10-16 所有绑定核验失败行的建议保护（未提交）

- 工作区为 pool-4 / `codex/final-restock-cli`，初始 HEAD `3107696452552e63853a435af51a7630faa0b335`，初始工作区干净。本轮只修改 `final_restock_workbook.py`、`test_final_restock_workbook.py` 和本交接；没有 Git 写操作、生产 ERP 调用或 Desktop 进程操作。
- 实际根因：之前仅用源表本地 SKU 是否非空设置 `_has_source_local_sku`，忽略了 `load_verified_source()` 已核对的「是否通过绑定核验」布尔结论。`source_verification.classify()` 的合法失败类别为本地 SKU 规范化后为空，以及非空但 catalog `stock_type=None`（未匹配、类型未核验）；普通和组合 SKU 的合法类型 1/2 通过。修复前 pool-4 用合法合成源表及实际 Office Kit 复现核验 False 却返回成功、`U2=空运（急发）`、`Y2=50`，0 公式错误并不能发现这种业务错误。
- 最小修复：映射行直接读取 `record[TAG_COLUMNS[1]]` 为内部 `_binding_verified`；写入公式及重算后检查共用此结论。False 行保留完整商品行、销量、库存、AG/AH 和 I/J/R/S，U–AC 九列不写建议公式且重算后公式和缓存必须为空；True 行原 13 列公式逐字保留。AH 合法空白回退、非空本地 SKU 或正 AG 库存均不能提升资格。没有另写 SKU 分类器，没有改变 13 列公式、共享来源/库存取数、CLI/catalog、Runtime 或普通备货。
- 来源结论可信且无回退：`load_verified_source()` 先核对店铺、来源与快照指纹，再重新分类，要求绑定三元标签与重算结果完全一致且资格字段为真正 bool，并核对数量。本轮未发现第三种遗漏的合法 False 类别；不完整/重复/非法 catalog、非法组合组件、缺失/篡改的 metadata 或绑定标签等仍是既有硬失败，不降级为空建议继续。全部行合法核验失败时仍允许保留分析表，不引入旧报表的「无可计算记录」拦截。
- 新增三组回归覆盖混合通过/失败、报告本地 SKU 全空的合法回退、全部失败；包含真正 type=2 组合商品、两种失败类别及正 AG 库存。每组实际生成并对输出再次调用 Office Kit 重算，检查两次结果的行、销量、AG/AH、全部公式文本及建议缓存；修复前 **3 failed**，修复后通过，已通过的组合样例仍为「空运（急发）」和空运实际 50。
- 从 pool-4 根、独立 `.venv`，配置本 handoff 已记录的 `LXE_OFFICE_NODE` / `LXE_OFFICE_CLI`，以 `UV_CACHE_DIR=/private/tmp/pool4-binding-uv PYTHONDONTWRITEBYTECODE=1 uv run --frozen --no-sync pytest -p no:cacheprovider` 运行 `test_final_restock_workbook.py`、`test_final_restock_workbook_cli.py`、`test_source_verification.py`、`test_source_verification_storage.py`、`test_final_restock_recommendation.py`、`test_replenishment_formula_sheet.py`、`test_mabang_store_msku_replenishment.py`：**306 passed，无 skip**。没有新增环境变量；catalog/JS 未改，不重复运行无关双端契约或全量测试。
- 使用 pool-7 已保存的 202610151516 MSKU 与同源深圳报告、202610151522 货件快照，在新临时目录生成 `/private/tmp/pr2-binding-eligibility-real-c0zilhpd/20261016Amazon-Yihaiqian-US补货最新.xlsx`。独立逐格核验：**2002 行、34 列、1978 行核验通过各 13 列公式、24 行不通过各 I/J/R/S，公式共 25810 个、U–AC 的 216 格公式及缓存为空、缓存 Excel 错误 0、ZIP CRC 有效**；AG、AH、销量 E–H、库存 K–Q 各 **2002/2002** 与原输入一致，三输入 SHA-256 前后不变。根代理另行读回文件及输入哈希确认。真实批次未包含非空但未匹配 SKU，该新增分支由上述合成回归证明。汇总在同目录 `verification-report.json`，脚本为 `/private/tmp/pr2-binding-eligibility-real-regression.py`；未覆盖原输入或 Desktop 附件。
- 当前具备 PR2 本地 Commit 的技术条件，三文件均未暂存/未提交；完整 diff 与 `git diff --check` 已核对。本轮不 commit、push、merge、rebase 或同步下游。Microsoft Excel 原生重算、Windows、全量合并前验证、build/typecheck 和修复后的 Desktop 交付仍为 **NOT VERIFIED**；T 列状态与 FBA 在途边界仍待业务确认。
- 安全同步方式（须另获 Git 授权）：先保存各层 HEAD 恢复引用、工作区逐文件副本/补丁与状态；PR2 提交此自属 fix 后，将 PR3 的自属提交从旧 PR2 `31076964` 重放到新 PR2，复核 `range-diff`；PR3 仅在自身 Skill/契约测试/交接中把「缺少本地 SKU」说明扩为「绑定核验未通过」。再将 pool-7 自属提交从旧 PR3 `04a6b024` 重放到新 PR3，恢复并核对其独立脱敏改动，禁止复制 PR2 服务/测试在下游重复提交。pool-7 同步应避开用户 Desktop 测试，并对整链做兼容和定向回归。
- pool-7 保护证据在 `/private/tmp/pool7-redaction-preservation-20261016.json`：原 HEAD `70181992`，库存 CLI 脱敏、对应测试、auto-data handoff 三个未暂存文件的完整差异及 SHA-256 均已保存。本轮结束时三个文件及整个 diff 与证据逐字节一致；后续恢复时 adapter/测试须哈希一致，handoff 须完整保留旧段后再追加同步记录。PR3 / pool-7 尚未继承本修复，不能以本轮 pool-4 验收声称运行中的 Desktop 已修复。

## 2026-10-16 本地提交授权收口

- 用户已明确授权仅在 pool-4 暂存并创建一个本地 fix Commit，范围为最终表服务、对应测试和本 handoff。提交备注为 `fix: suppress restock advice for all unverified MSKUs`，Commit ID 以本分支 `git log -1` 为准；原「未提交」章节保留为修复阶段记录。
- 服务与测试的 Git blob 分别为 `0f39e8fa`、`a894aecb` 开头，与 306 项通过时一致；本轮复用该定向证据，并重新核对真实回归汇总与 XLSX ZIP。源码和基线无变化，不重复运行 306 项或全量测试。提交前核对三文件完整差异、暂存范围及 `git diff --cached --check`；资格仍由来源核验 bool 统一控制，未恢复仅判断本地 SKU 非空的逻辑。
- 本轮仅进行获授权的 pool-4 本地暂存/提交，不操作其他分支、rebase、push、merge 或生产 ERP。pool-7 脱敏三文件及其完整 diff 已只读核对，仍与保护证据一致；后续 PR3 → pool-7 同步继续等待单独授权，按上一节备份和串行继承流程处理。
