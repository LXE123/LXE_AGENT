# 雅仓验证码登录与登录态复用交接

## 当前状态

- 工作区：`/Users/hym/PycharmProjects/LXE_AGENT1/.worktrees/pool-19`；分支：`codex/yacang-login-reuse`；基线：`c27a70fc840b66086de836cd8a11df0e29c9c858`。
- [上游 PR #151](https://github.com/LXE123/LXE_AGENT/pull/151) 尚未合并，实时 head 和工作区状态以 PR 与 `git status` 为准。本轮移除冗余 token 比较及绕过账号锁的测试。
- 按雅仓 → 马帮 TMS → 菲律宾顺序评审，菲律宾旧联调工作区予以保留；提交、推送和修改 PR 分别遵守用户授权。

## 完成内容与调用链

- `lxeskill yacang login <action>` 经 `services/commands/yacang/login.py` 进入 `workflow.login_action`，`action` 为 `prepare|submit|status|clear`，由 `YacangClient` 和 `YacangAuthState` 处理验证码及会话。
- `prepare` 读取已确认的 `data.key` 与 JPEG Base64 `data.captcha`；共享登录 Skill 识读验证码，`submit` 向现有 `loginV3` 提交结果。挑战提交前消费，5 分钟是本地时限，不代表平台时限。
- 导出经 `workflow.run` 复用本地 token；缺少会话返回 `login_required`，业务接口 401 清除登录态，签名下载的 401 不当作平台登录失效。账号登录与导出使用账号锁；403/429 不自动重试。
- 菲律宾报表需要本次新数据：内部调用可指定 `require_fresh=True`。如果此前提交状态不明，先确认旧任务已有结果，再提交本次导出；无法确认时保留旧任务状态并停止。普通雅仓导出默认行为不变。
- 账号凭据指纹隔离会话；POSIX 下目录和文件权限为 0700/0600，Windows 沿用应用状态目录 ACL。`status` 只表示本地状态，`clear` 不执行平台注销，也不取消已开始且持有内存 token 的导出。
- 保留 `shangman-login` Skill ID，由上马和雅仓共用；两平台的命令、凭据和状态仍独立。关闭该 Skill 会同时关闭两平台登录命令。`catalog.json` 注册命令，`docs/lxeskill-cli/commands.md` 从 catalog 生成。
- 继续使用桌面注入的 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD` 和 `LXE_DATA_ROOT`；验证码图片写入当前 `artifact_root` 的 `yacang/login` 目录。

## 验证证据

- 本轮恢复共享 Skill 的雅仓图片识读路径；雅仓、上马登录及 Skill scope 定向测试 **49 passed**（112 deselected），Skill 加载测试 **12 passed**。测试使用本机模拟；产品内模型识读真实验证码仍为 **NOT VERIFIED**。
- 本轮 `python/lxeskill_cli/tests/yacang` 为 **85 passed**，使用本机模拟服务；覆盖旧任务确认后获取新文件、无法查询时不重复提交，以及原有恢复行为。真实平台上的新流程 **NOT VERIFIED**。
- 本轮从工作区根目录运行雅仓及两项登录 Skill scope 定向测试：**85 passed**。使用本机模拟服务，没有访问生产；保留同账号登录与导出的锁测试、业务接口 401 及签名下载 401 的处理测试。
- 2026-11-06 经用户批准，真实雅仓验证码登录成功并持久保存。随后在隔离快照中复用登录态，真实导出菲律宾 PH8805 库存动销 **3663 行**及库存 **2470 行**，证实业务接口接受该登录态。
- 同次菲律宾联动中，马帮 TMS 第 5 批下载出现 `SSLError: UNEXPECTED_EOF_WHILE_READING`，来源不完整，最终合并文件没有生成；未确定 TLS 错误根因，也未再次请求生产。离线组合验证不能替代真实完整导出。
- 真实桌面验证码交付、Windows 文件 ACL、生产 token 生命周期及失效后的重新登录仍为 **NOT VERIFIED**。凭据只通过既有安全桥注入进程；pool-18 配置未修改。

## 已知限制

- 登录接口返回非 JSON 响应时，当前处理会丢失正文，可能无法保留具体错误原因。仓库缺少真实异常样本；现有脱敏规则不能保证隐藏错误文字中的未知 token，不能直接输出正文。
- 验证码图片位于获取时的工作区，挑战状态按账号共享。另一个工作区清除登录态会使旧挑战失效，但不会立即删除原工作区的图片；原工作区下次 `prepare` 或 `clear` 时清理。用户已接受该行为。
- 雅仓桌面配置没有 revision；运行中切换凭据时，旧进程不能实时检测全部跨进程配置变化。运行期间应避免切换账号凭据。

## 下一步

- 雅仓自动识读指引已随 PR 提交；产品内模型识读真实验证码仍为 **NOT VERIFIED**。菲律宾分支的共享 Skill 待前序修复归位后同步。
- 同账号登录提交和导出共用账号锁；此前恢复的 token 比较及其直接写入会话的测试绕过该锁，不能证明正常流程存在竞态，本轮已移除。PR 描述和评论应与当前代码及 85 项测试结果保持一致。
- 前序 PR 归位后，再验证 TMS 与菲律宾分支；不得把 pool-18 的未提交联调副本混入雅仓 PR。

## 2026-11-09：登录与续跑指引

- pool-19、`codex/yacang-login-reuse`：`skills/shangman-login/SKILL.md` 调整为图片识读不清或平台明确验证码错误时共用最多两次换图；`services/yacang/workflow.py` 为失败任务标记本轮已提交，供菲律宾任务区分旧任务和本次任务。凭据仍由 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD` 注入。
- 工作区根运行雅仓测试，使用本机模拟服务：85 passed；产品中模型识读、换图及真实平台错误格式尚未验证。Git 状态以 `git status` 为准；菲律宾分支保留相同改动并在前序归位后复核。

## 2026-11-09：按逐项审查结果删减测试

- 用户确认删除原审查编号 3、6、7、9、25、26、27：移除通用九文件全量导出、无数据日期导出、源表缺创建日期列、平台隐藏日期筛选，以及三个与日期/空仓库相关的参数校验场景。
- 保留其余已逐项确认的测试，包括跨国家共用的全局产品资料校验。没有改动生产代码或 PR；本轮未运行测试，结果 **NOT VERIFIED**。

## 2026-11-09：合并登录命令入口

- 按维护者要求，catalog 只注册 `lxeskill yacang login`，`prepare|submit|status|clear` 改为必填位置参数 `action`；调用写法不变。统一入口为 `services/commands/yacang/login.py`，移除原四个转发文件。`submit` 单独校验挑战编号和验证码，其余动作不接受这两个参数；验证码图片仍声明为 `model_input`。
- 同步共享登录 Skill 声明、命令帮助、手册及调用链说明。上马既有命令保持原契约。
- 已合入最新 main `cbc6a6cbcc96c121fe19ee3eec803644940db721`。在独立 worktree 根目录执行 `uv run --frozen pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra python/lxeskill_cli/tests/yacang`：**504 passed、4 skipped**，跳过的均为 Windows 专用用例。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：**5 passed**，包含通过真实 `lxeskill list` 查询单命令归属。新增 CLI 测试在本机模拟平台验证四个动作、非法参数拦截、只读帮助和验证码图片交付；没有访问真实 ERP。
- `git diff --check` 通过。真实模型验证码识读/换图、桌面交付和 Windows ACL/锁仍未验证。
