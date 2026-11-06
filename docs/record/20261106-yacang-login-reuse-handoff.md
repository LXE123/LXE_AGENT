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
