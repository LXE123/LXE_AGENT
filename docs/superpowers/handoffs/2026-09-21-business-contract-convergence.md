# 四平台业务契约收敛交接

## 用户目标与授权边界

- 目标：在保证雅仓、智慧印尼、智汇 TMS 和马帮巴西海外仓导出准确的前提下，收敛 Skill/catalog/terminal 契约，删除平台专用的 Runtime 前置路由和重复 Tool。
- 用户在 2026-09-21 明确要求“直接执行”，期望第二天可以直接启动测试。
- 固定目录：`/Users/hym/Documents/ChatGPT/项目合并/LXE_AGENT-integration`。
- 固定分支：`feature-amazon-replenish-multi-platform`；不得切换到 `main`。
- 不新建 Worktree、Pool 或项目目录；后续任务必须直接使用上述现有目录。
- 不更改现有管理员授权、GitHub Token、平台账号、生产开关或本机密钥链配置。
- 可在每个核心阶段通过测试、diff 和本交接文档收口后在当前分支提交；严禁 push，push 仍需用户单独确认。

## 设计与计划

- 已确认设计：`docs/superpowers/specs/2026-09-21-business-contract-convergence-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-21-business-contract-convergence.md`
- 设计文档已在当前分支的 `bdf6bd5c` (`docs: define business contract convergence`) 提交。
- 本交接更新时分支比远端 `origin/feature-amazon-replenish-multi-platform` 领先 2 个提交；未 push。

## 已完成：Task 1 雅仓四仓与全局入库契约

### 行为收敛

- 仓库集合和顺序仍只使用现有常量：`MY8801`、`PH8805`、`TH8802`、`VN8806`。
- `inventory-sales` 和 `inventory-current-snapshot` 支持单仓、任意有效多仓，省略仓库时默认四仓；执行顺序固定。
- `inbound-listing-time` 单独请求时，无论用户说单仓、多仓还是四仓，normalizer 都将仓库意图规范化为 omitted，effective warehouses 表示全四仓；planner 始终只产生一个 `global/all` 任务，不传仓库参数。
- 混合请求中，所选仓库只限制库存/销量；入库/上架仍是一份覆盖四仓的全局文件。
- Skill 和 catalog 已明确 `resolved` 必须使用复数 `values` 数组；单选也不接受 `value`。
- 没有修改雅仓 HTTP endpoint、登录、认证、分页、下载、工作簿验证、合并、重试、频控或风控代码。

### 本阶段已提交文件

- `python/lxeskill_cli/services/yacang/export_intent.py`
- `python/lxeskill_cli/tests/yacang/test_export_intent.py`
- `python/lxeskill_cli/tests/yacang/test_export_workflow.py`
- `python/lxeskill_cli/tests/yacang/test_cli_boundaries.py`
- `python/lxeskill_cli/tests/yacang/fixtures/export_intent_eval.json`
- `skills/yacang-export-workflow-map/SKILL.md`
- `python/lxeskill_cli/lxeskill/catalog.json`
- `python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`
- `docs/superpowers/plans/2026-09-21-business-contract-convergence.md`
- `docs/superpowers/handoffs/2026-09-21-business-contract-convergence.md`

### Git 收口

- 已在当前分支提交：`8a129cb7` (`fix: converge yacang warehouse intent contract`)。
- 该提交仅包含上述 Task 1 文件、实施计划和交接文档；未包含用户的其他 untracked 文件。
- 未 push；后续不得 push，除非用户再次单独确认。

### 已验证

1. 先跑红：新测试稳定暴露 4 个“入库仍保留单/多仓”旧契约失败，实现后消失。
2. `uv run pytest -q python/lxeskill_cli/tests/yacang/test_export_intent.py python/lxeskill_cli/tests/yacang/test_export_workflow.py python/lxeskill_cli/tests/yacang/test_cli_boundaries.py` → `298 passed`。
3. `uv run pytest -q python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` → `332 passed, 4 warnings`；警告是现有 aiohttp/Python 3.12 deprecation warning。
4. `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` → `4 pass, 0 fail`。
5. `git diff --check` → 通过。
6. 上述测试均为本地 fixture/单元测试，未发起任何生产网络请求。

## 已完成：Task 2 马帮巴西海外仓状态同义词契约（待提交）

- `replenishment-workflow-map` 和 catalog 现在使用同一个状态语义表：
  - 未签、未签收、待签、待签收、还没签收、尚未签收 → `allocation_pending_default_3m`。
  - 已签、已签收、已经签收、签收完成 → `allocation_signed_before_3m`。
  - 有巴西海外仓上下文但未指定签收状态的单据/调拨单据 → `allocation_both`。
- 裸词“签收”、“调拨”、“单据”现在明确要求澄清，不猜测已签或待签。
- `validate_brazil_export_parameters(...)` 仍只接受现有四个 canonical enum；其 docstring 明确自然语言翻译归选中 Skill，不进入全局 Runtime filter。
- 没有改动马帮认证、HTTP、分页、下载、工作簿、生产时间范围或重试/频控。

### Task 2 验证

1. 新增表驱动红测试，实现前稳定暴露 catalog 缺失同义词、Skill 缺失模糊边界以及 validator docstring 说明缺失。
2. `uv run pytest -q python/lxeskill_cli/tests/mabang/test_brazil_overseas_*.py python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py` → `51 passed`。
3. `uv run pytest -q python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` → `332 passed, 4 warnings`；警告是现有 aiohttp/Python 3.12 deprecation warning。
4. `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` → `4 pass, 0 fail`。
5. `git diff --check` → 通过。未发起真实马帮 API 调用。

## 现有本地状态与保护项

- 2026-09-22 已用 `LXE_DASHBOARD_DEV_PORT=5237 bun run desktop:dev` 完成本地 smoke test：Vite 、Gateway 和 Agent CLI 已就绪，`http://127.0.0.1:5237/` 返回 HTTP 200。未开启生产开关、未发起真实平台导出。
- 不要删除、覆盖或暂存以下用户原有 untracked 文件：
  - `HANDOFF-2026-09-19-auth-refresh-and-dev-launcher.md`
  - `HANDOFF-2026-09-19-four-platform-recovery.md`
  - `HANDOFF.md`
  - `PROBLEM-SUMMARY-2026-09-19.md`
  - `docs/harness/four-platform-export-integration-sop.md`
  - `docs/superpowers/plans/2026-09-18-four-platform-isolation-and-main-sync.md`
- 不得使用 `git reset --hard`、`git checkout --`、`git clean` 或其他破坏性命令。

## 2026-09-22 收敛补充（未提交）

- 此处先前记录的通用 `PendingSensitiveInputBroker` 方案已被 `upstream/main` 的上马持久化认证方案取代，不能作为当前实现依据。
- 上马 `run` 仅读取持久化 token；无 token、过期 token 或 ERP 401 都返回 `login_required`，且 401 只使被拒 token 失效，不自动重试 ERP 导出。认证恢复通过独立 `shangman-login` Skill 完成。
- 四平台紧凑 terminal matrix 已复验：雅仓保留完整成功、部分成功（成功文件和 `{task_id,data_type,warehouse,status,error_code}`）、失败、clarification questions；智汇、上马和马帮只暴露各自的最小业务摘要、文件和已脱敏错误。马帮巴西海外仓补齐 platform-local `terminal_projection`，不改公共 `business.py`。
- 智汇 TMS 的 `tryRunZhihuiConfirmation`、translator/router 等旧 source 标识扫描为空；`zhihui-tms-product-export` Skill 回归确认正常请求直接 execute，未恢复确认卡或 pre-turn Provider 调用。
- 当前验证：loopback broker 2/2、Python Shangman 19/19、四平台 terminal/TMS matrix 122/122；Runtime、Agent CLI、Dashboard typecheck 已通过。未访问生产接口、未提交、未 push。

## 新任务立即执行的顺序

1. 阅读本交接、设计、实施计划和本交接的 Task 2 补充文档，执行 `git status --short --branch`，确认工作目录仍为此目录、分支仍为 `feature-amazon-replenish-multi-platform`。
2. 等待用户对 Task 2 的精确提交授权。提交后从 Task 3 “紧凑 terminal-data 边界”开始；严格按计划实现 Task 3–6，然后才删除旧的 `shangman_captcha` Tool 和智汇 pre-turn/translator。
3. 不得先删旧路径再补替代实现；只有新通用机制和行为测试通过后才能删除。
4. 结束前执行 Task 7 完整验证，包括 workbook 内容、四仓集合、敏感信息、无关改动、`git diff --check`、类型检查和项目现有完整测试。

## 注意的实现原则

- 不新增“四平台总路由”、“总 Skill”、平台关键词 Runtime pre-filter 或每回合额外意图模型调用。
- 验证码迁移必须进入现有通用问题基础设施的 sensitive-image pending 模式，不能把答案、图片、Token 或 Cookie 写进 transcript/terminal/log/Git。
- 智汇确认必须由 catalog 元数据和通用 `UserQuestionService` 执行，绑定 session/turn/tool-call/精确规范化命令，一次性消费；Runtime 不得再出现 `if (zhihui)` 式分支。
- Python terminal 只返回模型下一步需要的业务摘要、恢复信息和附件；不再暴露整份内部 payload。
- 保证导出准确性的方式是不改现有平台底层实现，通过 fixture/工作簿验证端到端输入参数、Sheet、表头、行数和仓库值。

## 已完成：Task 6 智汇 TMS 普通 Agent 链路（未提交）

### 行为收敛

- 公开命令拆为精确路径：`tms philippines products-export preview` 与 `... execute`；两者都只接受 `platform=zhihui_tms`、`warehouse=PH`、`intent=product_export` 和非空、不重复的字段数组。
- `fields` 白名单为 `product`、`sku`、`sales`、`inventory`、`inbound`、`listing`。错误平台、仓库、意图、字段、重复字段或额外键在 Python 构造网络客户端前返回 `tms_plan_invalid`。
- execute catalog 声明通用 confirmation 元数据。Runtime 在启动进程前调用既有 `UserQuestionService`；只接受本次 Desktop 问题卡的“确认执行导出”。取消返回非错误的 cancelled observation，不启动 Python。
- 删除 Runtime 的 `tryRunZhihuiConfirmation`、额外 Provider 翻译、平台关键词预判与智汇专用确认 Router。智汇请求现通过普通 Agent 读取 Skill、调用 preview、调用 execute、确认后交付文件。
- 保留现有登录、生产门禁、账号锁、分页、下载、工作簿交付、部分文件交付、脱敏和智汇进度展示适配；没有发起真实第三方请求。

### 调用链与修改范围

`zhihui-tms-product-export/SKILL.md` → catalog preview/execute entries → generic `exec` confirmation gate → `UserQuestionService` → action-specific Python wrappers → shared `run_action` → existing Zhihui client/export/delivery.

- 新增：`services/agent_cli/zhihui/preview_products.py`、`execute_products.py`。
- 删除：`packages/agent/runtime/src/operations/zhihui-{confirmation,parameter-translator,parameters}.ts`、它们的测试及两份已废止的智汇设计文档。
- 尚满 pending-sensitive-input 改动仍处于未完成状态；已保留旧 RPC 兼容定义，之后必须完成 Dashboard/Host/Python channel 迁移测试后再删除旧尚满概念。

### 验证证据

1. `uv run pytest -q python/lxeskill_cli/tests/zhihui_tms` → `54 passed`。
2. `bun test packages/agent/runtime/test/engine/runtime.test.ts packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/coding-tools.test.ts packages/foundation/desktop-protocol/test/user-questions.test.ts apps/agent-cli/test/dashboard-service.test.ts` → 所有测试通过（Runtime 123、coding/lxeskill 34、protocol 4、DashboardService 3）；均为本地 fixture/单元测试。
3. `bun run typecheck` → 所有 workspace package 通过。
4. `rg -n 'tryRunZhihuiConfirmation|ProviderZhihuiParameterTranslator|zhihuiConfirmation|isExplicitZhihuiRequest' packages/agent/runtime/src apps/agent-cli/src` → 无匹配。
5. `git diff --check` → 通过；敏感扫描只命中尚满尚未迁移的现存 `captcha_code` 协议字段及其测试，没有检测到实际凭据。

### 后续操作

- 用户可先进行本地 Desktop/Agent 服务验收；不要开启 `ZHIHUI_TMS_PRODUCTION_ENABLED` 或注入真实凭据，除非另行明确授权。
- 未执行 `git add`、`git commit` 或 `push`。Task 6 如要提交，必须先获得用户对精确 staged 文件的授权。

## 当前未知与限制

- Task 1 已提交；本交接更新尚未提交，应与 Task 2 的交接更新一起精确提交，不得混入无关文件。
- 还没有实施 Task 2–7，不得宣称四平台整体改造已完成。
- 本地 Desktop 启动 smoke test 已执行；四平台业务的人工终验尚未执行。

## 已完成：智汇 TMS 加密登录态复用（未提交）

### 行为与调用链

- 首次执行导出时，Python 在现有账号锁内从 Desktop 会话服务读取与当前账号指纹匹配的 token；没有可用 token 才按既有低频、限次规则登录。
- 登录成功后，token 仅写入 Electron `safeStorage` 加密的 `secrets.bin`。它不会写入 `settings.json`、公开配置状态、日志、stdout、聊天结果或 Git。
- Desktop 重启后仍可复用有效 token。调用链为：`DesktopConfigStore` → `ZhihuiTmsSessionHost` → `ZhihuiTmsSessionProvider` → `ZhihuiTmsClient` → `export_products`。
- 账号变更、提供新密码、清空智汇配置或关闭生产开关，会在同一加密写事务中删除会话。缓存 token 与设置账号指纹不匹配时不会返回。
- Desktop 主进程新增仅回环的会话宿主：随机端口、32-byte 随机能力凭证、恒定时间鉴权、拒绝 `Origin`、16 KiB 请求上限、固定 `read/write/clear` 协议和 `Cache-Control: no-store`。只将 `LXE_ZHIHUI_TMS_SESSION_HOST_URL` 与 `LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN` 注入 Gateway 子进程环境，不进入 UI/IPC/日志。
- 只有明确 HTTP 401 会清除缓存、重新登录并重放同一个被拒绝请求一次。403、429、网络错误、下载错误、未知业务错误和第二次 401 都立即停止；不会猜测平台错误语义或无限重试。
- 没有 Desktop 会话宿主时（例如直接运行 Python CLI），行为安全降级为既有的每次执行登录一次；预览始终不读取网络或登录态。

### 修改文件

- Desktop：`apps/desktop/src/main/config-store/{model,setup,store}.ts`、`apps/desktop/src/main/zhihui-tms-session-host.ts`、`apps/desktop/src/main.ts`、`apps/desktop/src/main/desktop-gateway.ts` 及对应两组测试。
- Python：`python/lxeskill_cli/services/zhihui_tms/{client,session}.py`、`services/agent_cli/zhihui/export_products.py` 及智汇客户端、CLI、验收、会话 provider 测试。
- 设计与计划：`docs/superpowers/specs/2026-09-22-zhihui-tms-session-reuse-design.md`、`docs/superpowers/plans/2026-09-22-zhihui-tms-session-reuse.md`。

### 已验证

1. `bun test apps/desktop/test/config-store.test.ts apps/desktop/test/auth-browser-host.test.ts apps/desktop/test/zhihui-tms-session-host.test.ts` → `30 pass, 0 fail`。
2. `uv run pytest -q python/lxeskill_cli/tests/zhihui_tms` → `61 passed`。
3. `bun run typecheck` → 所有 workspace package 通过。
4. `bun run desktop:build` → Dashboard 与 Electron main/preload 均构建成功；仅有现有 bundle size 提示。
5. 上述均为本地存储、回环 HTTP、伪造会话或 fixture workbook 测试；没有向智汇或其他第三方发起请求。

### 已知限制与下一步

- 智汇没有经确认的 token TTL，因此不做定时刷新；只根据明确 HTTP 401 失效恢复。
- 仍未做真实智汇生产导出验证。Desktop 启动本身不触发智汇登录；只有用户在应用内确认 execute 才可能发起真实智汇调用。
- 未执行 `git add`、`git commit` 或 `push`。提交前须由用户授权精确文件集合。
- 未连接任何真实第三方平台，因此最终只能宣称本地模拟/契约验证成功，除非用户以后单独授权生产验收。

## 已完成：雅仓库存与销量 Contract 最小收敛（未提交）

### 本次调整

- 保留唯一自然语言 Skill `yacang-export-workflow-map` 和唯一 Agent 命令 `lxeskill yacang export run`。
- 保留三类 canonical data type：`inventory-sales`、`inventory-current-snapshot`、`inbound-listing-time`，没有新增第四类。
- “库存和销量/库存与销量/销量和库存”现在一次结构化请求同时解析为 `inventory-sales` + `inventory-current-snapshot`，执行时分别产出库存动销文件和当前库存文件。
- standalone “销量/库存动销”仍只选择 `inventory-sales`；standalone “库存/当前库存”仍只选择 `inventory-current-snapshot`；已有仓库范围、四仓顺序、入库全局一次任务和底层导出链路未改动。
- 同步修订 Skill、catalog、意图 fixture、规划测试和执行测试，避免 Skill/schema/parser/fixture 对同一业务表达产生不同解释。

### 验证证据

1. `uv run pytest -q python/lxeskill_cli/tests/yacang` → `397 passed`。
2. `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` → `4 pass, 0 fail`。
3. catalog JSON 解析和 `git diff --check` → 通过。
4. 包含全局 catalog 计数的整组测试当前受同一工作区内智汇新增两个命令影响（旧断言仍期待 48 个命令，当前为 49 个）；该失败与本次雅仓改动无关。
5. 未发起真实雅仓或其他第三方请求；未执行 `git add`、`git commit` 或 `push`。

## 最后小范围修复：雅仓全仓优先与 terminal 收敛（未提交）

- 全仓标记固定为“四仓、四个仓、全部仓库、所有仓库、全仓”；只要出现其中任一标记，就覆盖同句中的具体仓库，不再返回仓库范围冲突。
- 仓库 alias 由 `services.yacang.warehouses` 提供确定性映射；结构化 normalizer 同样归一并校验 canonical code。模型只负责理解语义，Schema 限制参数空间，CLI 做最终边界校验。
- Skill 结果规则明确：成功 terminal 的 `files` 一次交付后结束；部分成功保留成功文件，报告失败/跳过的 warehouse、data_type 和脱敏错误后结束，不自动重跑整单。
- 单仓/多仓文件描述改为适用于 `inventory-sales` 与 `inventory-current-snapshot` 的通用表述，`inbound-listing-time` 继续 global/all、只运行一次。
- 新增全仓+具体仓库、全仓双数据类型、结构化 alias、越南库存/销量/入库、部分失败文件保留和 terminal 单次交付回归测试。

### 本次验证

1. `uv run pytest -q python/lxeskill_cli/tests/yacang` → `412 passed`。
2. `uv run pytest -q python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py -k 'yacang_success_with_files_emits_one_terminal_and_stops or yacang_unified_cli_returns_canonical_clarification_envelope'` → `2 passed`。
3. 未修改认证、HTTP、下载、生产门禁、Runtime 主循环或其他平台；未发起真实第三方请求。

## 已完成：智汇 TMS 长期 Contract 收敛（未提交）

### 当前 Contract

- 智汇 preview 与 execute 的唯一公开参数为 `platform=zhihui_tms`、`warehouse=PH`、`intent=product_export`；三个字段均为 required const，`additionalProperties=false`。
- `fields` 已从 Skill、catalog、CLI argv、normalizer、intent dataclass 和执行链路删除。旧 callers 传入 `fields` 会在任何网络客户端构造前以 `tms_plan_invalid` 拒绝。
- 当前轮明确提到“智汇”或“TMS”但未说明国家时，Skill 固定归一为 PH，不追问国家；“菲律宾库存”仍因平台不明确而不进入智汇。当前轮平台覆盖历史 Context，且不接管雅仓、智慧印尼、马帮巴西请求。
- preview 不读网络、不读登录态、不生成文件，终态为 `ok=true`、`confirmation_required=true`、`files=[]`。execute 的现有 confirmation card 仍是唯一业务门禁，确认后沿用同一三字段参数，不重新解释自然语言。
- execute 完整成功时 outer `files` 是唯一最终交付真源，outer data 只含 `platform`、`country=PH`、`business_type=product_export`、`row_count`；Skill 要求直接交付 files 后结束。
- 已验证部分文件时，outer terminal 为 `ok=false`、`data.partial=true`、部分页/行计数、已验证部分 files，outer error code 为 `tms_export_partial`；不得称完整成功。无部分文件的失败保持 `partial=false` 与实际脱敏错误。

### 通用终态投影边界

- `lxeskill.business` 新增可选 `terminal_projection`：只有业务 payload 主动提供 object data 时才替换 outer terminal data；失败时只有业务主动提供完整 projection error 才替换 outer error。
- artifact 收集仍只基于原 payload 的 catalog `artifact_paths`，通用层不识别平台、不依据文件数量或 partial 判断业务状态。
- 未提供 projection 的雅仓、智慧印尼/尚满、马帮 payload 仍输出原 data、原文件行为和 `business_cli_failed` 回退码；新增参数化测试及其他平台现有 fixture 回归均已覆盖。

### 本次验证

1. `uv run pytest python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py -q` → `62 passed`。
2. `uv run pytest python/lxeskill_cli/tests/zhihui_tms python/lxeskill_cli/tests/lxeskill/test_command_contracts.py python/lxeskill_cli/tests/lxeskill/test_lxeskill_contract.py -q` → `179 passed`。
3. `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` → `4 pass, 0 fail`。
4. `uv run pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/yacang/test_export_intent.py python/lxeskill_cli/tests/yacang/test_export_workflow.py python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py -q` → `517 passed`。
5. 全部验证均为本地 fake module、CLI、catalog 或 workbook fixture；未访问智汇或其他生产平台，未执行 `git add`、commit 或 push。

### 本次文件与范围

- 修改：智汇 Skill、catalog、`services/zhihui_tms/intent.py`、`services/agent_cli/zhihui/export_products.py`、`lxeskill/business.py` 及对应 Python/Bun 测试。
- `planner.py` 已检查且不再传播 fields，因此无需修改；认证、HTTP、session host、分页、下载、XLSX 合并和 Bun Runtime 主链均未修改。
- `test_lxeskill_cli.py` 同步修正既有智汇 preview/execute 双命令导致的 catalog 数量与 legacy alias 基线，并增加 generic projection outer-terminal 回归；没有改变其他平台业务 Contract。
