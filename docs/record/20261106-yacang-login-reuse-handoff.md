# 雅仓验证码登录与登录态复用交接

## 当前状态

- 工作区：`/Users/hym/PycharmProjects/LXE_AGENT1/.worktrees/pool-19`；分支：`codex/yacang-login-reuse`；基线：`c27a70fc840b66086de836cd8a11df0e29c9c858`。
- [个人仓库 PR #13](https://github.com/Arsenal20262/LXE_AGENT/pull/13) 已创建，待评审、尚未合并。本地提交 `0be3dd2c` 尚未推送；实时状态以 `git status` 和 PR 为准。
- 本轮精简工作在上述提交基础上进行，提交、推送和修改 PR 分别遵守用户授权。按雅仓 → 马帮 TMS → 菲律宾顺序评审，菲律宾旧联调工作区予以保留。

## 完成内容与调用链

- `lxeskill yacang login prepare|submit|status|clear` 经 `services/commands/yacang/login_*.py` 进入 `workflow.login_action`，由 `YacangClient` 和 `YacangAuthState` 处理验证码及会话。
- `prepare` 读取已确认的 `data.key` 与 JPEG Base64 `data.captcha`；`submit` 向现有 `loginV3` 提交用户填写的验证码。挑战提交前消费，5 分钟是本地时限，不代表平台时限。
- 导出经 `workflow.run` 复用本地 token；缺少会话返回 `login_required`，业务接口 401 清除登录态，签名下载的 401 不当作平台登录失效。账号登录与导出使用账号锁；403/429 不自动重试。
- 账号凭据指纹隔离会话；POSIX 下目录和文件权限为 0700/0600，Windows 沿用应用状态目录 ACL。`status` 只表示本地状态，`clear` 不执行平台注销，也不取消已开始且持有内存 token 的导出。
- 保留 `shangman-login` Skill ID，由上马和雅仓共用；两平台的命令、凭据和状态仍独立。关闭该 Skill 会同时关闭两平台登录命令。`catalog.json` 注册命令，`docs/lxeskill-cli/commands.md` 从 catalog 生成。
- 继续使用桌面注入的 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD` 和 `LXE_DATA_ROOT`；验证码图片写入当前 `artifact_root` 的 `yacang/login` 目录。

## 验证证据

- 本轮从工作区根目录运行雅仓及两项登录 Skill scope 定向测试：**85 passed**。使用本机模拟服务，没有访问生产；删除了一项绕过生产账号锁的竞态模拟测试。业务接口 401 清除登录态和签名下载 401 不清除的测试保留。
- 2026-11-06 经用户批准，真实雅仓验证码登录成功并持久保存。随后在隔离快照中复用登录态，真实导出菲律宾 PH8805 库存动销 **3663 行**及库存 **2470 行**，证实业务接口接受该登录态。
- 同次菲律宾联动中，马帮 TMS 第 5 批下载出现 `SSLError: UNEXPECTED_EOF_WHILE_READING`，来源不完整，最终合并文件没有生成；未确定 TLS 错误根因，也未再次请求生产。离线组合验证不能替代真实完整导出。
- 真实桌面验证码交付、Windows 文件 ACL、生产 token 生命周期及失效后的重新登录仍为 **NOT VERIFIED**。凭据只通过既有安全桥注入进程；pool-18 配置未修改。

## 已知限制

- 登录接口返回非 JSON 响应时，当前处理会丢失正文，可能无法保留具体错误原因。仓库缺少真实异常样本；现有脱敏规则不能保证隐藏错误文字中的未知 token，不能直接输出正文。
- 验证码图片位于获取时的工作区，挑战状态按账号共享。另一个工作区清除登录态会使旧挑战失效，但不会立即删除原工作区的图片；原工作区下次 `prepare` 或 `clear` 时清理。用户已接受该行为。
- 雅仓桌面配置没有 revision；运行中切换凭据时，旧进程不能实时检测全部跨进程配置变化。运行期间应避免切换账号凭据。

## 下一步

- 本轮删除无用凭据引用、重复的验证码大小检查，以及账号锁已覆盖的 401 token 比较；压缩交接记录。独立复核未发现明确生产回归。提交后按用户授权流程推送，并补充 PR 说明。
- 前序 PR 归位后，再验证 TMS 与菲律宾分支；不得把 pool-18 的未提交联调副本混入雅仓 PR。
