# 雅仓验证码登录与登录态复用交接

## 当前工作区

- Worktree：`/Users/hym/PycharmProjects/LXE_AGENT1/.worktrees/pool-19`
- 分支：`codex/yacang-login-reuse`
- PR 基线 / 当时本地 `origin/main`：`c27a70fc840b66086de836cd8a11df0e29c9c858`。2026-11-06 通过 GitHub 只读 compare 确认当时远端 `main` 与此提交相同；本地 Git 代理不可用，当前远端状态需在提审前重新核对。
- 用户批准按两层提交：先提交雅仓登录态存储及独立测试，再提交验证码登录、导出接入与配套指引。尚未 push 或创建 PR；工作区状态以 `git status` 为准。

## 完成内容

- 增加 `lxeskill yacang login prepare|submit|status|clear`，沿用 lxeskillCLI catalog、Python Service 和既有 `read` 图片输入路径。
- 登录 prepare 读取已确认的 `data.key` 与 JPEG Base64 `data.captcha`；submit 通过现有 `loginV3` 以 `key` / `verify_code` 提交。challenge 提交前消费；5 分钟是本地使用时限，不表示平台时限。过期文件在后续 prepare 或 clear 时清理，没有定时清除任务。
- token 保存在 lxeskillCLI 雅仓账号独立私有目录，POSIX 下目录/文件权限为 0700/0600；Windows 沿用应用状态目录 ACL（Windows 的 `chmod` 只控制只读属性）。账号及凭据指纹隔离。未猜测 token 有效期；状态仅报告本地存在，平台 401 时清除本地 token。clear 不声称平台注销。
- 雅仓导出改为使用已保存 token，缺失时返回 `login_required`；登录 submit 和导出共用账号锁，按被拒绝 token 清理 401，clear 后旧的取图或登录不能写回。403/429 不自动重试。
- 用户批准合并后，上马和雅仓共用 `shangman-login` 图片验证码登录 Skill。沿用既有路径和 ID 以保留禁用状态、显式调用与命令 scope；平台 CLI、接口、凭据和状态各自独立。禁用该 Skill 会同时禁用两平台的登录命令。中文展示名改为“上马与雅仓图片验证码登录”，历史统计使用相同 ID 的展示名也随之变化。
- 雅仓报表导出指引先读取共享登录 Skill；该 Skill 已禁用或不在可用范围时，需要启用后才能检查或获取登录态，不绕过既有禁用规则。
- 按用户要求精简共享登录 Skill，重点说明配置、平台命令、登录路径和必要的平台差异；验证码一次性提交及风控处理等实际边界保留。

## 文件与调用链

- `python/lxeskill_cli/services/yacang/client.py`：verify 图片解析、一次 loginV3 提交和已有 API token header。
- `python/lxeskill_cli/services/yacang/auth_state.py`：私有 token/challenge 文件、单次消费、过期挑战清理及文件锁。
- `python/lxeskill_cli/services/yacang/workflow.py`：登录动作与导出 token 复用/401 失效清理。
- `python/lxeskill_cli/services/commands/yacang/login_*.py` → `python/lxeskill_cli/lxeskill/catalog.json` → `skills/shangman-login/SKILL.md`；`docs/lxeskill-cli/commands.md` 由 catalog 生成。
- 环境配置沿用桌面注入的 `LXE_YACANG_MOBILE` / `LXE_YACANG_PASSWORD`；状态根沿用 `LXE_DATA_ROOT`，图片写入当前 `artifact_root` 下的 `yacang/login`。

## 验证与限制

- 两层提交整理后：登录态独立测试 `6 passed`；雅仓、lxeskill、infra 合计 `497 passed, 4 skipped`（4 条 aiohttp 弃用警告）；Bun 命令归属、Skill 和标签测试 `19 passed`。`lxeskill doctor`、共享 Skill 兼容校验和命令手册一致性检查通过。均为离线验证。
- 本次收口复跑：雅仓、lxeskill、infra 测试 `493 passed, 4 skipped`，Bun 三组定向测试 `19 passed`；随后新增登录 Skill scope 边界用例，与既有登录 scope 用例一起复跑 `2 passed`。Python 模拟测试需要监听本机地址，沙箱内首次执行因权限限制失败，已在允许本机监听的环境重跑。均未请求生产服务。
- 本次 requesting-code-review / simplify 审查去掉雅仓登录态原子替换后重复的权限设置，避免文件已保存却因额外 chmod 失败而误报未保存；替换前仍对临时文件设置权限。新增故障注入回归修复前失败、修复后通过。复跑雅仓、lxeskill、infra 测试 `495 passed, 4 skipped`（4 条 aiohttp 弃用警告），仅本地模拟。
- 随后独立复核发现替换失败及临时文件清理同时失败时，清理错误会覆盖原始错误；现保留两者并加故障回归，原登录态文件保持不变。故障测试修复前失败、修复后通过；雅仓定向回归 `81 passed`。真实 Windows 文件锁与 ACL 未验证。
- Skill 精简后，仓库 `quick_validate.py --compatibility` 校验通过，Skill 运行时测试 `12 passed`，`git diff --check` 通过；没有重新执行真实登录。
- 雅仓、上马、lxeskill、infra 四个测试目录合计 584 passed、4 skipped；其中雅仓部分在最后一处清理错误处理修复前执行。最终雅仓目录单独复跑：79 passed。均使用本地模拟，没有生产请求；组合测试出现 4 条既有 aiohttp 弃用警告。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/skills.test.ts apps/dashboard/test/shared/skill-labels.test.tsx`：19 passed。
- `lxeskill doctor` 和共享 Skill 的 `quick_validate.py --compatibility` 通过；独立审查以离线模拟实际调用 prepare、submit、status，确认 CLI 返回包络及可读取的合成 JPEG。
- 已复查 diff、Git 状态与敏感信息；`git diff --check` 和未跟踪文件空白检查通过。
- 用户另行批准测试后，2026-11-06 10:43（中国标准时间）使用 pool-19 的 CLI 真实获取雅仓图片验证码，由 Codex 读取图片并识别，一次 submit 返回 `login_succeeded=true`、`persisted=true`；随后另一个 CLI 进程执行 status，返回 `authenticated=true`、`online_verified=false`。测试没有提交报表或调用报表查询；该状态只证明本地保存和读取，不能证明 token 已被后续业务接口接受。
- 测试通过项目既有安全凭据桥只读使用 pool-18 的雅仓配置，凭据仅在进程内注入，未持久配置到 pool-19 桌面；登录态保存在 pool-19。当前 pool-19 桌面雅仓账号仍未配置，后续从该桌面运行时需要配置相同账号。pool-18 源配置没有被修改。
- 产品内模型 `read` 真实验证码、生产 token 生命周期、Windows 文件 ACL 与平台失效后的重新登录仍 NOT VERIFIED。`clear` 不执行平台注销，也不取消已经开始并持有内存 token 的导出。
- 跨工作区限制：验证码图片在获取时所在工作区，挑战状态在账号共享目录。在 B 工作区清除登录态会使 A 的旧挑战失效，但不会立即删除 A 的图片；A 下次执行 `prepare` 或 `clear` 时清理。已用隔离目录复现，用户确认接受延后清理；不跨工作区删除图片或改变产物契约。
- 雅仓桌面配置没有上马的配置 revision；进程运行中修改桌面雅仓凭据时，旧进程不能实时检测更新。凭据指纹防止旧读取删除新凭据会话，但不能保证所有跨进程配置变更交错，需避免在执行中切换凭据；若需彻底处理，另行评估桌面配置契约。

## 菲律宾报表隔离联动（2026-11-06）

- 用户批准一次真实完整验证。为保留 pool-18 未提交任务，使用 `/private/tmp/lxe-ph-yc-integration-58xhhwhm` 临时快照组合 pool-19 雅仓认证与 pool-18 菲律宾/TMS 代码；七项关键源码的 SHA 与来源工作区核对一致，使用 pool-19 自己的 Python 环境，未复制 `.venv`。菲律宾 Skill 登录前置补丁和串联测试只在临时快照，尚未写回 pool-18。
- 隔离快照的菲律宾原测试、TMS 测试及新增联动测试共 **274 passed**，`lxeskill doctor` 通过。主代理另独立复跑新增联动测试 **4 passed**；这些测试覆盖真实雅仓 workflow 使用虚拟登录态、两份文件合并，以及无登录态时阻止 TMS 调用，使用本机模拟服务，无生产数据。
- 本次实际执行一次 `philippines reports export`：雅仓 PH8805 库存动销 **3663 行**、当前库存 **2470 行**均成功导出，证实已保存登录态被雅仓业务接口接受；另用菲律宾来源读取器分别完成本地校验。
- TMS PH1 登录成功，第 1–4 批共 4000/4557 条接口记录下载并校验；第 5 批下载返回 `SSLError: UNEXPECTED_EOF_WHILE_READING`，仍有 557 条未完成。部分文件含 3912 个 SKU，经来源读取器校验结构，但不代表完整来源。组合命令返回失败、最终 `files=[]`，未生成两份最终合并文件。
- 同类 TLS 下载错误此前也曾出现，但现有证据不足以确定服务端、网络或客户端的根因；不能据此判定风控，也不能关闭 TLS 校验。离线模拟相同 `SSLEOFError` 的既有部分失败用例重跑 **1 passed**，仅证明失败处理，不证明真实 TLS 根因。历史验收 `docs/acceptance/mabang-tms-export-validation.md` 也未确认下载链接可否重复 GET、有效期或一次性限制，因此现有下载不自动重试且没有断点续传；本次没有再发起第二轮生产请求。
- 本次单轮验证的凭据通过既有安全桥在进程内注入，数据和产物写入 pool-19；pool-18 保持不变。后续如要将菲律宾适配写回其未提交任务，需遵守原 pool-18 保留要求及上游 PR 依赖；如需再次生产验证，先明确具体操作与授权。

## 下一步

- 第一个 PR 只收录本分支雅仓登录相关改动；推送和创建 PR 分别取得授权。后续 TMS 修复、菲律宾报表按既定顺序基于前序结果收口，菲律宾现有未提交代码先保留。
- 后续生产登录/取数须获得对应任务授权。不要将 pool-18 菲律宾/TMS 未提交改动纳入本分支。

## 2026-11-06：三分支代码审查

- 在 pool-19 的 `codex/yacang-login-reuse` 使用 requesting-code-review 和 simplify 审查，修复验证码响应损坏时图片数据、登录失败响应中回显的 token 可能进入诊断的问题；解析错误放在长响应之前，保留真实错误。修改 `services/yacang/client.py`、`errors.py` 和 `tests/yacang/test_export.py`，登录入口、配置及环境变量不变。
- 从本工作区根目录运行雅仓测试：**90 passed**；使用本机模拟服务，未连接生产。此轮未重新进行真实登录，真实端到端结果为 **NOT VERIFIED**。
- 以 pool-18 未提交工作区为基础，在 `/private/tmp/lxe-branch-review-7xtiduk7` 临时副本覆盖 pool-19、pool-20 本轮相关代码及测试，独立创建虚拟环境后运行三组测试：**368 passed**。这只证明离线组合兼容，未更改三个分支之间的 Git 关系或同步下游。
- 本轮修复及交接尚未暂存或提交。pool-18 仍是此前联调代码，尚未包含这次前序修复；按雅仓 → TMS → 菲律宾顺序评审，前序修复归位后再验证下游。提交、推送及 PR 分别遵守用户授权。

## 2026-11-06：测试精简复核

- 按用户要求使用 simplify 和 test-audit 审查本分支。独立复核后恢复一个异常登录响应边界测试；没有删除雅仓测试，也没有新增生产代码改动。原有 55 个测试声明保持不变，未强行达到约 20% 的精简目标。
- 本工作区雅仓测试 **90 passed**；覆盖率前后均为行 745/818（91.08%）、分支 213/264（80.68%），逐文件覆盖数无下降。均为本地模拟，真实 ERP 未验证。详见 `/private/tmp/three-branch-test-audit-20261106.md`；原有未提交改动保留，未暂存或提交。

## 2026-11-06：PR 准备复核

- 保留本分支登录态实现；雅仓需要验证码时由用户查看图片并完成验证，导出部分成功后只重试可明确指定的未完成范围，避免重复提交。修改 `skills/shangman-login/SKILL.md` 和 `skills/yacang-reports-export/SKILL.md`，底层登录/导出命令及环境变量不变。
- 本工作区雅仓、lxeskill 与 infra 测试 **505 passed、4 skipped**；相关 Bun 测试 **19 passed**，Skill 兼容校验通过。`send_files` 使用合成 artifact 的工具调用通过；真实桌面图片交付和人工验证码登录未验证。原 coding-tools 测试中的 split roots 用例因环境缺少 `fd` 而未通过，另一个文件交付用例 **1 passed**；见实际结果，不将该环境受阻项写成通过。
- 最新 main 和三个工作区代码在独立临时快照组合后，三组测试 **363 passed**；不是分支同步。审查修复、Skill 和交接未暂存或提交，提交、推送和 PR 分别需要用户授权。

## 测试占比复核

- 用户要求测试代码不超过功能及测试代码合计的 30%。按相对本分支基线的新增行计算，功能 326 行不变，测试 415→392 行，占比 56.0%→54.6%；未达到 30%，若继续删除还需减少至少 253 行，现有审查无法证明不会失去独有契约。
- 通过合并权限保存与跨进程读取、401 失效处理、验证码图片验证及长错误校验减少重复；登录安全、图片校验和实际异常断言保留。覆盖率前后行 91.08%、分支 80.68%，逐文件无下降；本工作区定向 **90 passed**（含两项 CLI scope 测试）。独立复核发现并补回长错误截断场景，隔离变异验证可捕获旧故障。备份与核对记录见 `/private/tmp/lxe-audit30-backup-lvkf4y2u` 和 `/private/tmp/three-branch-ratio30-audit.md`。

## 2026-11-07：提交前复核

- 用户授权提交当前分支改动。雅仓目录离线测试 **88 passed**；登录 Skill 范围定向测试 **2 passed**。雅仓测试使用本地模拟 HTTP 服务，未访问生产；沙箱内因端口权限失败后在允许本机监听的环境复跑。
- 密钥扫描命中的是测试构造的合成令牌；`git diff --check` 通过。真实桌面验证码交付和完整生产导出仍为 **NOT VERIFIED**。下一步由用户分别决定是否推送及创建 PR；菲律宾分支仍需整理旧联调副本并按依赖验证。

## 2026-11-07：按批准方案精简登录态

- 分支 `codex/yacang-login-reuse`，工作区 `pool-19`，基于 `10bcfee41e0ab812da777603639e170354b5cd5a`。本轮仅修改 `python/lxeskill_cli/services/yacang/auth_state.py` 和本交接文件。
- `_read_session` 继续负责读入并校验会话，`session` 与 `status` 直接使用校验结果；账号目录创建及权限统一由 `lock` 完成，删除 `_atomic_json`、`prepare`、`save_session` 的重复处理。图片目录、图片和临时文件权限，以及锁、登录代次和错误处理保持原行为。生产代码净减少 6 行，测试未改。
- 入口仍为 `lxeskill yacang login prepare|submit|status|clear`，由 `workflow.login_action` 调用登录态服务；导出经 `workflow.run` 复用会话。沿用 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD`、`LXE_DATA_ROOT`，验证码图片使用当前 `artifact_root`。
- 从本工作区根目录运行 `UV_CACHE_DIR=/private/tmp/lxe-yacang-simplify-uv-cache uv run --frozen pytest python/lxeskill_cli/tests/yacang -q --tb=short`：**88 passed**。已确认 Python 和导入源码均属于 pool-19。沙箱内首次运行因本机 HTTP 监听权限受阻，批准后在允许监听的环境运行同一离线测试；没有生产请求。本轮真实 ERP、桌面登录及 Windows 文件权限为 **NOT VERIFIED**。
- 独立复审未发现新增必修问题；已检查 diff、敏感信息、无关文件和 `git diff --check`。用户已批准暂存、提交上述两文件，补丁与本交接放在同一提交；代码与 88 项测试通过时一致。下一步按雅仓 → TMS → 菲律宾顺序提审，推送和创建 PR 分别申请授权；菲律宾旧联调副本仍待整理。

## 2026-11-08：测试新增行占比收口

- 工作区 `pool-19`、分支 `codex/yacang-login-reuse`，本轮起点 `8e7b47b4`，比例仍相对功能分支基线 `c27a70fc` 统计。功能新增 320 行不变，测试新增 **392→319 行**，占比 **55.06%→49.92%**，满足本轮每分支不超过 50% 的要求；按 Git 新增行计算，未使用净行数或删除基线旧测试凑数。
- 只修改 `tests/yacang/test_export.py`、`test_auth_state.py` 与本节交接。将同一入口的 prepare/submit 错误、clear 两个时机、锁拒绝与单次消费合并为显式场景表；原子发布、跨进程读取、旧凭据保护、双重文件错误与 clear 共用一个存储生命周期。孤儿图片检查并入真实 HTTP 成功登录；坏 JPEG 和像素上限也通过真实 HTTP 验证，减少一个 request mock。
- 真实 HTTP、XLSX、子进程、文件锁、错误原文、脱敏、缺 token、孤立 surrogate、清除代次和文件清理断言保留。生产代码、命令入口、环境变量、CLI scope 测试均未修改；入口与调用链沿用前文，PR 依赖仍按雅仓 → TMS → 菲律宾顺序。
- 从 pool-19 根目录使用与基线相同的 coverage.py 7.17.2 `--branch` 命令运行雅仓测试及两项 CLI scope 测试：**86 passed**。基线 90 个案例中的 4 个并入生命周期 keeper；其余参数场景保留。比较 16 个生产文件的已覆盖行和分支集合，均无损；合计行 **751/842（89.19%）**、分支 **216/272（79.41%）** 前后相同。此口径包含 `services/commands/yacang`，与历史仅业务模块覆盖率分母不同。
- 审计 ledger、原始快照与 before/after coverage 位于 `/private/tmp/lxe-ratio50-x4n4v6k9/pool-19/`。独立逐段复核未发现断言丢失；两项内存变异分别让旧凭据误删当前 session、让 prepare 忽略 clear 代次，两个 keeper 均在相应行为断言失败，恢复后 **3 passed**。16 个生产文件 SHA 与本轮起点完全一致。测试仅使用本机模拟 HTTP 和临时文件；真实 ERP、桌面图片交付、Windows ACL 为 **NOT VERIFIED**。
- 已复查测试 diff、`git diff --check` 与工作区状态，独立保留契约复核通过；本轮改动未暂存、提交或推送。下一步按授权边界申请 Commit；Push、创建 PR 仍须分别明确确认。

## 2026-11-08：个人仓库 PR 准备

- 用户指定目标为 `Arsenal20262/LXE_AGENT`。只读查询确认其 `main` 为 `c27a70fc840b66086de836cd8a11df0e29c9c858`，与本分支基线一致；目标仓库当前没有同名 `codex/yacang-login-reuse` 远端分支。本机 `main` 仍为 `89b81bd7`，不需要为本 PR 修改它。
- 本次复用上节的 **86 passed** 记录：测试与 16 个生产文件自该次验证后未变，逐文件覆盖集合无下降。额外只读核对命令手册的生成区域与 catalog 一致，`git diff --check origin/main` 通过。真实桌面验证码交付及 Windows 权限仍为 **NOT VERIFIED**。
- 用户批准提交后重跑雅仓及两项 CLI scope 测试：**86 passed in 25.50s**。首次沙箱内运行因 `127.0.0.1` 模拟服务无法绑定端口出现 48 项 setup 错误，随后在允许本机监听的环境重跑通过；均未连接生产。
- 当前计划独立提交两份雅仓测试文件及本交接，提交说明拟为 `test(yacang): consolidate login regression coverage`。PR 草稿见 `/private/tmp/lxe-yacang-fork-pr-20261108.md`。本次未执行 Git 暂存、提交、推送或创建 PR；提交、推送和创建 PR 按用户的授权流程分别进行。
