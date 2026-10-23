# 最终备货建议：PR3 Skill 入口与命令契约

## 目标与最小计划

让“最终备货建议”及“将原始备货建议量表转换成新表”进入独立 Skill，使用明确的离线输入调用 PR2 命令；普通备货继续走现有流程。

- 分支：`codex/final-restock-skill`，Pool：`.worktrees/pool-6`。
- 当前基线：PR2 `ef11bbf1`（含 AG/AH 与未绑定商品两个修复），父链含 PR1 `70bc0568`。2026-10-15 已备份旧 PR3 HEAD `63672882` 并仅重放本 PR 的四个提交；较早的参数同步记录保留在下文。
- 依据：Downloads 中的 `Amazon_%E6%9C%80%E7%BB%88%E5%A4%87%E8%B4%A7%E5%BB%BA%E8%AE%AESkill_%E5%BC%80%E5%8F%91%E6%96%B9%E6%A1%88.md` 的 PR-A；公式以用户确认规则及 PR1 handoff 为准。
- 2026-10-15 基线同步阶段仅更新 PR3 自属 Skill、契约测试和本 handoff，未另行提交；随后获授权将这三个文件收为一个本地契约提交，不 push、merge、创建远端 PR 或连接生产 ERP。

### 改动文件与职责

| 文件 | 最小改动 |
|---|---|
| `skills/replenishment-final-restock/SKILL.md`（新增） | 新意图、明确离线输入、一次命令调用、真实失败及产物交付；独立于旧计算规则，因此单独建 Skill。 |
| `skills/replenishment-workflow-map/SKILL.md` | 新意图优先路由到新 Skill，不运行旧完整流程。 |
| `skills/replenishment-calculate/SKILL.md` | 明确普通备货与最终备货建议的选择边界。 |
| `python/lxeskill_cli/lxeskill/catalog.json` | 将既有命令改为 business / exposed，并归属新 Skill；参数和实现不变。 |
| `python/lxeskill_cli/tests/lxeskill/test_final_restock_skill.py`（新增） | 新命令发现、唯一归属、完整参数、缺输入、源店铺不匹配及错误产物 JSONL 契约。 |
| Python `test_lxeskill_cli.py`、Bun `lxeskill-command.test.ts` / `skills.test.ts` | 更新数量并覆盖命令归属、实际 Skill 发现与权限过滤。 |
| `docs/harness/skill/current_skill_catalog.md`、本文件 | 更新清单与本阶段验证/交接。 |

### 实施顺序

1. 先补新入口的 catalog/发现测试，运行确认当前命令仍是 internal，新增 Skill 尚未发现。
2. Skill 列明四个必需参数：`store_name`、`msku_source_xlsx_path`、`shenzhen_inventory_report_xlsx_path`、`unlinked_shipments_snapshot_path`；已有输入直接计算，缺失或名称含糊先澄清，不启动生产取数。
3. 修改最小 metadata 与新旧 Skill 边界，更新清单和既有数量断言。
4. 运行 Python `lxeskill` / `infra` 和 PR2 文件/CLI 定向测试；运行 Bun `lxeskill-command.test.ts` / `skills.test.ts`；实际执行 CLI doctor/help。缺参沿用既有业务校验诊断，不假定 CLI 通用层会执行普通 JSON Schema required 校验。
5. 检查 diff、空白、敏感信息、状态和 PR1/PR2 保护情况，补齐 handoff 后做一次本地功能提交。

## 复用与边界

调用链：Skill discovery / workflow map → 新 Skill → `lxeskill replenish final-restock generate` → PR2 CLI/文件服务 → PR1 公式 → 既有 Office 执行与产物机制。

店铺身份由已有源文件核验判断，不能用模型猜测别名或把本地不匹配说成生产店铺不存在。缺少规范店铺名或任何输入时先报告缺失项；源核验的实际异常仍由既有 CLI 返回。此阶段不额外调用生产店铺查询或导出。

本 PR 不拥有公式、输入映射、数据源、Office 执行、旧 42 列报表或公共架构。2026-10-13 用户最新确认 AA 的 V/W 双空值门槛、AC 的 AB/AD 空值保护及 AD 表头“单件重量”；分别由 PR1/PR2 更正，本 PR 仅同步说明。其他失败文件仍仅作诊断，不声称零错误验收通过。

## 完成范围

- 新增 `replenishment-final-restock`，沿用 `replenishment` 权限域，独占 `lxeskill replenish final-restock generate`。catalog 仅修改既有命令的 visibility、owner_skills、exposed；参数、返回字段、失败产物及执行服务保持 PR2 契约。
- 新旧入口描述明确区分主触发词与转换别名；普通备货仍用原 map/计算，单纯发送旧流程最终文件不切换规则。缺输入先澄清，不扩大为在线采集。
- 真实源核验测试确认错误店铺返回请求/快照名称；四类缺参返回对应输入诊断，已移除的旧 flag 返回明确的 unknown option。JSONL 测试确认成功和公式错误都会保留既有字段、产物路径，错误仍为 `ok=false`。
- 范围共 10 个文件：3 个 Skill 文件、1 个 catalog、4 个测试文件、2 个文档。没有新增业务服务、命令、环境变量或依赖。

## 初始提交测试证据（历史）

2026-10-13，从本 worktree 根执行。已确认解释器位于 `pool-6/.venv`，services 导入路径指向本 checkout，没有共享其他 worktree 的虚拟环境。

```sh
UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache uv run --frozen --no-sync pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py -q --tb=short -rs
# 502 passed, 5 skipped, 4 warnings

bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/skills.test.ts
# 25 pass, 0 fail, 177 assertions

UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache uv run --frozen --no-sync lxeskill doctor
# ok=true：47 catalog commands / 41 business commands / 38 Skill files / 31 owners / 41 declarations

UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache uv run --frozen --no-sync lxeskill replenish final-restock generate --help
# ok=true：business，owner=replenishment-final-restock，五个原有必需参数
```

- Python 初次在沙箱内运行有 59 项本地模拟服务器相关失败；在沙箱外重跑上述同一范围后全部通过，没有为绕过失败修改生产代码。4 条 warning 为已有 aiohttp 废弃提示。
- 跳过 4 项 Windows 路径/进程归属测试，另 1 项 PR2 真实 Office 端到端测试因 `LXE_OFFICE_NODE` 未配置跳过。
- 新增 12 项 Python 用例覆盖公开发现、scope 隔离、五类缺参、真实源店铺不匹配和成功/失败 terminal；Bun 覆盖实际 manifest 发现、类型权限过滤、归属和新旧描述边界。
- 测试先确认了 internal/未发现状态导致失败；缺参测试最初误假定通用 CLI 执行所有 required 校验，核对调用链后改为验证真实业务诊断，未增加公共校验层。
- 未运行全量测试或 build/typecheck：改动是入口 Markdown、catalog metadata 和测试，依项目规范仅运行直接相关检查；全量验证留待最终合并阶段。

## 环境、限制与下一步

- Office 继续使用 PR2 的 `LXE_OFFICE_NODE` / `LXE_OFFICE_CLI`；本轮已配置临时测试运行环境并完成实际 Kit 重算，路径与准备方式见 PR2 handoff。本次没有修改应用宿主持久配置。`UV_CACHE_DIR` 仅是本次测试缓存，不是产品新增环境变量。
- 正式产物目录仍由 `replenish_final_restock_recommendation` dataset 解析；命名及输出由 PR2 所有，Skill 只交付 terminal 的真实 files。
- **NOT VERIFIED：** 真实模型自然语言选 Skill/文件发送、Microsoft Excel 原生计算、真实业务同批次源文件的最终 XLSX 验收。静态描述与契约检查不等同于模型行为验证；terminal 测试使用隔离模拟服务，实际 Office 重算证据来自独立文件服务端到端测试。
- 本阶段不需要生产 ERP/API；店铺校验仅确认离线来源一致性，不代表查过生产店铺列表。
- AA/AC 及表头规则现已确认，各层提交和依赖同步已完成。下一步准备真实同源离线输入并完成业务验收；模型入口和文件发送仍需单独验收。若要自动取数，需另开范围明确的阶段，不在本 PR 中追加。
- 主仓库 review 仍按 PR1 → PR2 → PR3 串行；本 PR 依赖 PR2 最新提交，不提前 merge 或机械同步整条 stack。

## 初始提交 Git 交接（历史）

- 本阶段实现、测试与本交接采用一个本地提交：`feat: expose final restock recommendation skill`；提交号以 `git log -1 codex/final-restock-skill` 为准。
- 收口检查覆盖全部 10 个改动文件（含 3 个新增文件）、空白和凭据模式。PR1/PR2 服务、CLI 适配器、业务测试及 lockfile 相对 `afc9528f` 无差异。
- PR1 保持 `e9b88b92`，PR2 保持 `afc9528f`，两个工作区及主工作区均未被本任务修改；其他已领取 pool 不参与本任务。
- 没有 push、远端 PR 或 merge。保留 `pool-6` 和 stacked 分支供评审，后续阶段原则上在新聊天、独立 pool 中继续。

## 2026-10-13 截图规则更新（同步前记录）

- 本轮仅修改本 PR 的 Skill 说明及本 handoff（2 个文件），去掉过时的“严格 AC、不允许加空值保护”要求，改为用户新确认的 AA/AC/AD 口径；错误报告和 Office 未验证提示保留。
- 运行 `bun test packages/agent/runtime/test/tooling/skills.test.ts`：**13 pass, 0 fail, 92 assertions**。未改 catalog，因此未重复全套双端测试。
- 公式失败 terminal 的合成测试仍保留，验证任意真实错误可被交付为诊断，不意味着合法输入在新公式下仍应产生 AC 错误。
- Git HEAD 仍为 `563efd4d`；本轮未 add/commit、未 rebase。PR1/PR2 的更正各自在其工作区，尚未传播到本 checkout，故新规则的全链回归仍为 **NOT VERIFIED**。
- 待批准后按 PR1 → PR2 → PR3 提交和同步依赖，再对受影响层运行定向回归；提交前检查各自 diff/状态/敏感信息。无需修改 main 或连接生产 ERP。

## 2026-10-13 已授权同步与最终回归

- 用户提供原始参考 XLSX，并明确允许分别本地提交、备份旧提交和 PR1 → PR2 → PR3 rebase。原件 SHA-256 与方案相符，34 个表头、2003 行的 26039 个公式逐字比对零差异；原件公式缓存为空，未改写用户原件。核验详情和 Office 环境见 PR1/PR2 handoff。
- 已建立 3 个本地备份分支：`codex/final-restock-formulas-before-xlsx-20261013` → `e9b88b92`，`codex/final-restock-cli-before-xlsx-20261013` → `afc9528f`，`codex/final-restock-skill-before-xlsx-20261013` → `563efd4d`。保留原分支和 Pool，不删除旧提交。
- PR1 的 AA/AC 更正为 `70bc0568`；PR2 表头及测试更正为 `a2139ab0`，加同步验证记录后 HEAD 为 `797436bd`。PR3 的 Skill 说明更正重放为 `cc82b36d`，原入口功能提交 `563efd4d` 重放为 `c43710c0`，`git range-diff` 确认原功能内容不变。
- PR2 / PR3 rebase 均无冲突，祖先检查确认 `main → PR1 → PR2 → PR3`。PR1 已基于当前 main `9f36647a`，无需改变基线。PR3 中上游服务、业务测试和上游 handoff 与 PR2 完全一致，没有把前序更正留在下游兜底。

本 worktree 根目录，使用自身 `.venv`，运行：

```sh
LXE_OFFICE_NODE=/Users/hym/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
LXE_OFFICE_CLI=/private/tmp/lxe-final-restock-office-runtime/office/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js \
UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache \
uv run --frozen --no-sync pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra python/lxeskill_cli/tests/mabang/test_final_restock_recommendation.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py -q --tb=short -rs
# 639 passed, 4 skipped, 4 warnings

bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/skills.test.ts
# 25 pass, 0 fail, 177 assertions

UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache uv run --frozen --no-sync lxeskill doctor
UV_CACHE_DIR=/private/tmp/lxe-final-restock-uv-cache uv run --frozen --no-sync lxeskill replenish final-restock generate --help
# 两条均 ok=true，doctor 数量与初始提交相同，命令归属和五个参数未改变。
```

- Python 测试为允许本地模拟服务器监听而在沙箱外执行，没有访问生产 ERP。4 项 skip 均为 Windows 专属路径/进程测试，4 条 warning 为既有 aiohttp 提示；Office 用例已实际执行，没有跳过。
- 本轮证明小样本文件服务经过真实 Office Kit 重算可生成零公式错误的 34 列 XLSX；清货 AC 留空，有效海运重量仍是数量乘克数。它不证明用户完整业务输入集或模型交付链已验收。
- 已检查各层 diff、`git diff --check`、敏感信息模式和变更归属；main 与其他 Pool 未修改。仅补交本层最终验证记录，最新 HEAD 以本分支 `git log -1` 为准；没有 push、远端 PR 或 merge。后续主仓库 review 仍需按 PR1 → PR2 → PR3 串行，并分别取得对应远端操作授权。

## 2026-10-14 参数收敛的契约同步（依赖同步前的历史记录）

- PR2 已在 pool-4 删除重复输入，保留内容指纹、店铺、核验快照/批次、来源元数据、MSKU 覆盖及货件核验。本轮先报告跨层同步事项，再仅修改本 PR 自属的 Skill、`test_final_restock_skill.py` 和本 handoff，共三个文件；没有把 PR2 的 catalog、服务或业务测试复制到本 checkout。
- 新 Skill 说明与示例改为店铺和三个文件，共四项输入；契约用例同步四项输入和四类缺参，并新增旧 flag 必须返回 `invalid_arguments / unknown option` 的回归。保持新旧命令归属、scope 隔离、真实源店铺错误与成功/失败产物语义。
- 本分支 HEAD 仍为 `24907386`，其上游仍是 PR2 `797436bd`。用户明确禁止本轮提交和 rebase，所以真实依赖尚未同步；在本 checkout 运行单项输入契约测试实际得到 **1 failed**，原因为继承的 catalog 仍是五项输入，而本轮测试要求四项。这是待同步状态，不宣称当前 PR3 独立验收已通过。
- 为验证预计的组合结果，使用 `git archive HEAD` 创建 `/private/tmp/restock-contract-review-6van87v3/combined`（普通临时源码副本，不是 Git worktree）。只在副本叠加 PR2 待审核文件、本 PR 自属修改；catalog 仅接入 PR2 的 input_schema，保持 PR3 的 business/exposed/owner metadata。执行 `uv sync --frozen --offline` 建立独立 `.venv`，实际确认解释器及 lxeskill/服务导入均指向该副本。没有复制或共享其他 worktree 的 `.venv`；JS 仅复用既有依赖目录。
- 扩展组合检查运行 Python `tests/lxeskill`、`tests/infra` 和两份最终备货文件测试：**500 passed, 4 skipped, 5 failed, 4 warnings**。五项失败全部属于 `infra/test_repo_structure.py`，实际诊断为临时归档缺少 `.git`，`git ls-files` / `git check-ignore` 退出 128；不得把这一命令整体标为通过。这类检查已在 PR2 原工作区通过，本轮没有修改目录结构。四项 skip 为 Windows 专属，warning 为原有 aiohttp 提示。
- 隔离到本轮目标契约，组合副本运行 `uv run --frozen --no-sync pytest -p no:cacheprovider python/lxeskill_cli/tests/lxeskill/test_final_restock_skill.py -q -rs --tb=short`：**12 passed，无 skip**；CLI doctor/help 均 `ok=true`，help 的参数恰为四项。组合副本的 Bun `lxeskill-command.test.ts` / `skills.test.ts` 已 **25 pass，177 assertions**。这些结果证明合成依赖组合，不替代真实分支同步。
- 本 worktree 既有 `skills.test.ts` **13 pass，92 assertions**；`runtime.test.ts -t 'skill loading|records skill activation once'` **8 pass，78 assertions**。它们覆盖 manifest 发现、命令归属、加载与显式激活，Runtime 响应仍是 Mock，不证明真实自然语言选择。
- 真实模型只读选择测试 **NOT VERIFIED**：按现有 Runtime 的 `loadProviderDescriptor()` 和本地 auth 路径加载 PR3 / 主工作区配置，均实际返回 `missing API key for provider: deepseek`，auth 文件不存在，未能启动真实模型选择。没有发送模型请求、调用生产 ERP、增加关键词路由、修改 Runtime 或创建分发框架。
- 旧参数在本 PR 自属的活跃 Skill/正向测试中已移除，仅保留旧 flag 拒绝测试和历史说明；当前 checkout 的上游 catalog/CLI/服务仍含旧参数，等待经审核授权后的 PR2 提交及依赖同步。PR2 可以评审；PR3 的自属 diff 可预审，正式整体验收需先同步上游并重新核验真实分支，模型选择仍按上述 NOT VERIFIED 处理。
- 验证结束后已删除本轮创建的临时组合源码、归档及其独立虚拟环境。简要结果保留于 `/private/tmp/final-restock-parameter-review-report.json`，Bun 与 Runtime 日志分别为 `/private/tmp/final-restock-combined-bun.log`、`/private/tmp/final-restock-runtime-routing-regression.log`；均无业务输入或凭据。

## 2026-10-14 正式分支同步与集成验证（提交前验证记录）

- PR2 已独立审核并提交 `37128c3a190471adb837d49761c1ce97f95d9f05 fix: remove redundant final restock source path`，pool-4 工作区干净。PR3 同步前 HEAD `24907386` 已保存在 `codex/final-restock-skill-before-param-sync-20261014`；三个未提交文件通过 stash `52d123fa9af8ba4f11c4549b7fcb72e08fa1fb19` 备份并恢复，备份保留。另有逐文件 SHA-256 与完整 patch：`/private/tmp/final-restock-close-backup-xa8m0cry`。
- 先检查共同基线 `797436bd` 与 `merge-tree`，再执行 `git rebase --onto 37128c3a 797436bd`，三条既有 PR3 提交重放成功、无冲突。新 HEAD 为 `6f496e9e069d7205e9087f8bff72292961f5bbad`；映射为 `c43710c0 → be6f8e22`、`cc82b36d → de65576a`、`24907386 → 6f496e9e`。`range-diff` 只有第一条的 catalog 上游 schema 上下文变化，后两条完全相同；没有新增 PR3 业务提交。
- 恢复后、更新本交接记录前，三个文件 SHA-256 和整个未提交 patch 均与同步前完全相等。PR3 自有待提交文件仍只有 Skill、`test_final_restock_skill.py` 和本 handoff；其余变化均通过上游继承，没有跨分支复制服务代码。
- 正式 pool-6 的 catalog、CLI、服务签名和 Skill 均统一为店铺与三个文件。相对 PR2，catalog 只改 business/exposed/owner 归属；来源核验、服务实现和业务测试与 PR2 完全相同。活跃实现无旧参数，旧 flag 仅存在于两份明确拒绝它的测试，历史 handoff 保留变更记录。
- 在本 worktree 根运行，实际断言 Python 解释器、lxeskill 及服务导入路径均属于本 worktree 独立 `.venv` / 源码。环境继续使用 PR2 记录的 Office 两变量及临时 UV cache；未复制或共享 `.venv`，未改依赖或 lockfile。
- 正式定向 Python 命令：`uv run --frozen --no-sync pytest -p no:cacheprovider python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra python/lxeskill_cli/tests/mabang/test_final_restock_workbook.py python/lxeskill_cli/tests/mabang/test_final_restock_workbook_cli.py python/lxeskill_cli/tests/mabang/test_source_verification.py -q -rs --tb=short --junitxml=/private/tmp/final-restock-pr3-sync-python.xml`：**551 passed, 0 failed, 4 skipped, 4 warnings**。其中新 Skill 契约 **12 passed**；之前失败的 `test_final_restock_is_exposed_with_one_owner_and_the_existing_inputs` 已实际通过；正式 Git 目录结构测试 **8 passed**。真实 Office Kit 小样本重算已运行，无 Office skip。
- 四项 skip 为两项 Windows 路径和两项 Windows Office 进程所有权测试；四条 warning 为既有 aiohttp 弃用提示。模拟 HTTP 测试只使用本机服务器。临时副本缺少 `.git` 的历史结果不计入本次正式分支验收。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/skills.test.ts`：**25 pass, 0 fail, 177 assertions**。`bun test packages/agent/runtime/test/engine/runtime.test.ts -t 'skill loading|records skill activation once'`：**8 pass, 0 fail, 97 filtered out, 78 assertions**；筛除项未运行，Runtime provider 为 Mock，不代表真实模型语义选择。
- CLI `doctor`、`replenish final-restock generate --help` 均退出 0、`ok=true`；doctor 为 47 catalog / 41 business / 38 skill / 31 owner / 41 declaration，help 恰为四项输入、唯一 owner 为新 Skill。工作差异与相对 PR2 的 `git diff --check` 通过。
- 真实模型选择 **NOT VERIFIED**：重新通过既有 `loadProviderDescriptor()` 读取 pool-6 和主工作区配置，均返回 `missing API key for provider: deepseek`，本地 auth 文件不存在；没有发送模型请求或绕过凭据要求。新旧 Skill 简介/命令归属、scope 隔离和 Runtime 加载回归通过；不据此宣称自然语言一定选对。
- 本次正式日志：`/private/tmp/final-restock-pr3-sync-python.log`、`/private/tmp/final-restock-pr3-sync-python.xml`、`/private/tmp/final-restock-pr3-sync-bun.log`、`/private/tmp/final-restock-pr3-sync-runtime.log`。未运行全仓库测试、build/typecheck、Windows 原生测试、Microsoft Excel 原生计算、真实完整业务输入或附件发送，均不宣称已验收。
- 本轮未发现 P0–P3 代码缺陷、架构违规或新增过度设计；已删减冗余参数，无新入口、公共抽象、兼容适配层或硬编码路由。PR3 离线集成已具备代码 Review 条件；自身三个修改文件待用户审核授权提交，远端 Review 仍依 PR1 → PR2 → PR3 串行。未 push、merge 或访问生产 ERP，main、PR1 与其他 Pool 未修改。

## 2026-10-14 最终审核与本地收口

- 审核起点为 pool-6 / `codex/final-restock-skill` / `6f496e9e`，共同基线及直接依赖为 PR2 `37128c3a`。待提交文件恰为 Skill、契约测试、本 handoff，暂存区为空；未 rebase 或修改其他分支。
- Skill 表格、命令示例、契约用例与 PR2 catalog / CLI / 服务均为“店铺名＋三个文件”。旧参数在生产实现中没有残留；旧 flag 仅作为明确拒绝测试输入。新命令仍只有一个 Skill owner，新旧入口按现有 discovery 与 scope 隔离，没有新增路由代码、兼容层或重复命令。
- 复核正式 pool-6 的既有日志与 JUnit：Python **551 passed, 0 failed, 4 skipped, 4 warnings**，Bun **25 pass**，Mock Runtime **8 pass / 97 filtered out**。HEAD、Skill / 契约测试 SHA-256 与验证时一致，其余源码无后续修改，证据仍有效。没有重复运行 551 项或全仓库测试。
- 提交前补跑 `uv run --frozen --no-sync pytest -p no:cacheprovider python/lxeskill_cli/tests/lxeskill/test_final_restock_skill.py -q -rs --tb=short`：**12 passed, 0 failed, 0 skipped**；Bun `lxeskill-command.test.ts` / `skills.test.ts`：**25 pass, 0 fail, 177 assertions**。使用本 worktree 独立 `.venv`；`git diff --check` 及相对 PR2 的 diff 检查通过。
- 审核发现并更正本 handoff 当前说明中的旧“五项”文案。另有 **P3 文档 follow-up**：`docs/harness/skill/current_skill_catalog.md:57` 仍写“深圳库存报告及其关联源路径”；该导航文档不是 Runtime Skill 正文，不影响已验证命令，但会误导读者。本轮限定只提交三个文件，因此保留并报告，未擅自修改第四个文件；最小后续更正为删除“及其关联源路径”。没有发现阻塞性代码问题。
- 本次三个文件以 `fix: align final restock skill with four-input contract` 本地提交，实际提交号以本分支 `git log -1` 为准。PR3 相对 PR2 独立范围仍为 10 个文件：3 个 Skill、1 个 catalog metadata、4 个测试、2 个文档；不包含 PR2 服务、业务测试、公式或上游 handoff 的重复差异。
- 具备代码 Review 条件，附上述非阻塞 P3 文档项。真实模型选择（缺 DeepSeek API Key）、全量测试、build/typecheck、Windows 原生路径、Microsoft Excel 原生计算、真实完整业务输入与附件交付继续为 **NOT VERIFIED**。未 push、merge、创建远端 PR 或调用生产 ERP。

## 2026-10-15 继承 PR2 两项修复与契约收口

- pool-6 `codex/final-restock-skill` 原 HEAD `63672882`、工作区干净，直接依赖 PR2 旧基线 `37128c3a`。pool-4 最新 HEAD `ef11bbf1`，包含 `75a1556e` AG/AH 映射与 `ef11bbf1` 未绑定保护；pool-7 有独立未提交改动，本轮仅查看其状态，没有清理、覆盖或写入。GitHub 连接查询 PR3 原四个提交均返回未找到，本地无远端跟踪分支；备份分支 `codex/final-restock-skill-before-pr2-fixes-20261015` 保留旧 HEAD `63672882`。
- 在 pool-6 执行 `git rebase --onto ef11bbf1 37128c3a`，四个 PR3 提交无冲突重放，映射为 `be6f8e22→c4b1d2f2`、`de65576a→ad7e19a1`、`6f496e9e→ea45a3f3`、`63672882→43b07ff7`。`range-diff` 四项完全相同；新 HEAD `43b07ff7` 的直接上游为最新 PR2 `ef11bbf1`。PR3 相对 PR2 仍是原 10 个自属文件，未重复提交 PR2 服务或测试。
- 本轮仅修改新 Skill、`test_final_restock_skill.py` 和本 handoff：模型可见输入明确要求 MSKU XLSX 含 `uq122` 导出的“本地库存”；AG 允许有限负数并区分 0/空白，AH 使用同源深圳报告组合编码并保留源表回退。未绑定 MSKU 保留原始行、销量及 I/J/R/S 公式，U–AC 九列建议为空；已绑定行仍有原 13 列公式。CLI 参数仍是店铺名加三个文件，不接入 pool-7 的自动取数、Cookie 或 searchToken。
- 新 Skill 契约 **14 passed**，包括 CLI 对缺少“本地库存”列的真实错误传播和 Skill 规则文本。正式工作区 Python 定向与相关回归 **566 passed、4 skipped、4 warnings**；四项跳过均为 Windows 专属，warning 为既有 aiohttp 弃用提示。首次沙箱运行有 59 项因本机 `127.0.0.1` 模拟服务器绑定被拒而失败，随后在允许本机监听的环境完整重跑并通过，不将首次结果当作代码缺陷。Bun 命令/Skill **25 passed、177 assertions**；Mock Runtime Skill 加载 **8 passed、97 filtered out、78 assertions**。CLI doctor/help 均 `ok=true`，help 只有四项输入；解释器和服务模块路径均属于 pool-6 自身 `.venv` / 源码。
- 本次契约修订恰为上述三个文件，提交前已检查完整 diff、`git diff --check`、相对 PR2 的 10 文件独立差异与 pool-4 / pool-7 状态；本地提交号以本分支 `git log -1` 为准。pool-7 后续须先备份当前提交及未提交 patch（含未跟踪样本）并核验可恢复性，再在单独授权下同步新 PR3 基线，不能直接对脏工作区 rebase。T 列货件状态边界、真实模型选择、全量测试、build/typecheck、Microsoft Excel 原生重算及继承修复后的真实业务交付均为 **NOT VERIFIED**。旧导航文档的 P3 文案项仍待另行处理；未发现新增阻塞性代码问题。本轮未调用生产 ERP、push 或 merge。

## 2026-10-15 继承 PR2 审计修复的交接

- 同步前 pool-6 HEAD 为 `82f4f7a0`，工作区有 PR2 修复的服务、测试、PR2 handoff 镜像及本 handoff，暂存区和未跟踪文件均为空。HEAD 恢复引用为 `refs/backup/pool6-before-pr2-31076964-20261015`；工作区补丁、逐文件副本、状态与已有 stash 清单存于 `/private/tmp/final-restock-pr2-sync-70ef2uz5/pool-6`，已校验可恢复。远端没有对应分支、当前提交或 PR。
- 清除已备份的重复工作区镜像后，从旧 PR2 `ef11bbf1` 将 PR3 的五个自属提交重放到 PR2 修复 `31076964`；无冲突，新 HEAD 为 `26d0d9ac`。`range-diff` 五项均相同；相对新 PR2 的已提交差异仍为原 10 个 PR3 文件，未重复提交 PR2 最终表服务、测试或 handoff。本 handoff 的自属未提交修改已恢复，其他工作区差异为零。
- 同步后 Python 最终表、来源核验及 Skill 定向测试 **92 passed**；Bun 命令/Skill 契约 **25 passed**；Mock Runtime Skill 加载/激活 **8 passed、97 filtered out**。`git diff --check` 通过；基线同步阶段未调用生产 ERP、未新增功能修复 Commit 或修改 pool-4。pool-7 已继承上述代码基线；本 handoff 文档提交后仍需让 pool-7 继承最新 PR3 HEAD。

## 2026-10-16 继承 PR2 绑定核验保护并同步 pool-7（未提交）

- 起点：pool-4 `codex/final-restock-cli` / `894a413edc3ccebcc464ec288ae80b0ec7c2f5f9` 干净；pool-6 `codex/final-restock-skill` / `04a6b024082f39eabfbd0699d7b7cddb4bd0c677` 干净；pool-7 `codex/final-restock-auto-data` / `701819929190306a9049d16dc01248a1e2598f4c` 有三处未提交差异。三条已有 stash (`stash@{0}` `751c55b6`、`stash@{1}` `52d123fa`) 均保留。Git CLI 远端查询因本机代理不可用；只读 GitHub API 对 PR3、pool-7 分支均返回未找到且无 PR。
- 同步前在 `/private/tmp/final-restock-stack-sync-20261016` 保存 pool-6、pool-7 完整 refs/stash bundles、工作区 patch、状态、SHA 和未跟踪清单。两个 bundle 的 `git bundle verify` 成功；隔离恢复验证重建了原 HEAD 与 stash 引用，pool-7 三个修改文件逐字节匹配、未跟踪文件数为 0。此目录是恢复备份，不是提交内容。
- PR3 原基线为 PR2 `3107696452552e63853a435af51a7630faa0b335`。六个既有 PR3 提交重放到 PR2 fix `894a413e`，无冲突，PR3 新 HEAD `a2a2d06b2c62c49ae1ca997693cb4af305b128f3`；`range-diff` 六项全部相同。相对 PR2 的提交范围仍只有 PR3 原有六个提交、10 个自有文件，不包含 PR2 最终表服务或工作簿测试。
- PR3 原 Skill/契约测试只描述“本地 SKU 缺失”，未覆盖非空 SKU 未匹配。仅在本层 Skill 与其定向测试中明确：来源绑定核验未通过（本地 SKU 为空或未能匹配库存/组合目录）仍保留真实行、销量及 I/J/R/S，U–AC 无建议；通过核验商品保留 13 列公式。没有新建核验逻辑、Runtime 路由或算法。当前变更为 Skill、`test_final_restock_skill.py` 与本 handoff 三文件，均未暂存或提交。
- 本 worktree 根用 Office Kit 实际重算运行 PR2 最终表、来源核验、公式、普通备货及 PR3 Skill 定向组：**320 passed，无 skip**。覆盖空 SKU/非空未匹配、正常绑定、组合与合法回退；失败行 U–AC 空、已核验行 13 列公式保留，输出二次 Office 重算断言通过。Bun 命令/Skill **25 passed、177 assertions**；Mock Runtime Skill 加载 **8 passed、97 filtered、78 assertions**。此前同轮真实文件离线产物记录仍为 2002 行、34 列、25810 公式、0 Excel 错误；PR2 服务与测试 blob 与本分支完全一致（`0f39e8fa` / `a894aecb`），本轮没有修改这些文件。
- pool-7 从旧 PR3 `04a6b024` 安全重放四个自有提交到新 PR3 `a2a2d06b`，无冲突；新 HEAD `2e1be7a4ee56f0b2f9a62c6f0ee057f8de46adba`。`range-diff` 四项全部相同；相对 PR3 仍为原有 20 个 pool-7 文件，无 PR2 最终表服务/测试重复差异。原有 searchToken CLI 脱敏、测试与 handoff 三文件已由已验证 patch 恢复；服务与测试 SHA 与同步前一致。搜索/下载自动取数、`uq122`、Cookie、HTML 错误识别及失败停止均保留。
- pool-7 Python 离线回归 **471 passed**，覆盖工作簿 Office 重算、来源核验、普通备货、MSKU 与库存服务/CLI、HTML 停止和 searchToken 脱敏；Bun **25 passed、190 assertions**；Mock Runtime **8 passed、97 filtered、78 assertions**。`range-diff`、完整分支文件清单、`git diff --check` 已核对。未发现新增 P0–P2 或新的 P3 缺陷。既有 P3 文案项 `current_skill_catalog.md:57` 仍在 PR3 版本中写离线输入及“深圳报告关联源路径”；pool-7 自有提交已改成当前自动取数契约，PR3 本层未扩大修改范围。
- 当前 pool-4 干净；pool-6 有上述三文件未提交、暂存区及未跟踪文件为空；pool-7 保留三文件未提交 searchToken 修复/测试/handoff、暂存区及未跟踪文件为空。PR3 的新 Skill 文案修订尚未进入 PR3 HEAD，因此 pool-7 目前继承的是最新已提交 PR3 基线；待后续授权提交 PR3 后，pool-7 还需一次基于新 PR3 HEAD 的同步，才能在提交链中继承这段新文案。没有新增 Commit、push、merge 或生产 ERP 请求。Microsoft Excel 原生重算、Windows、全量合并前测试、真实模型选择及 Desktop 实际交付仍为 **NOT VERIFIED**。
