# CLI 状态写入边界修复交接

## 当前工作区与 Git

- 最终修复：`codex/pr1-cli-state-compat`，pool-19；基线 `upstream/main` / `5f78534174b76461a352bd326aabba33f2942b48`。
- pool-17 保留原审查版本；pool-19 的本次迁移修复已原样同步到 pool-20/21/22。
- 2026-10-08 验收时四层为未提交累计快照。2026-10-09 用户批准受控暂存/提交及建立 PR1 → PR2 → PR3 → PR4 父链，并授权仅同步本地 origin。最终 hash、工作区状态和同步结果以 git log/status 及仓库外交付记录为准；不推 GitHub，不创建线上 PR。
- 原三个业务分支保持 clean：TMS `cb07ec4a`、上马 `e57801e1`、雅仓 `06301fff`；旧工作区不覆盖。

## 根因、边界与调用链

上马需要多次审批的已确认根因是公共 CLI 初始化日志时无法写宿主状态目录，并非验证码或商品业务。调用链仍是 Skill → 独立 business exec → Python CLI → terminal.files → 既有 send_files。

- 复用现有 catalog 与 exec 适配。仅登记的独立 `visibility=business` 子进程在 Workspace Write 下获得宿主固定 `lxeskill/`、`db/lxeskill/`、`logs/` 三目录能力。
- 普通/read-only/内部命令、shell 组合不获得此能力；不默认 Full access，不开放整个 data root、Bun DB、配置或 exec-session 状态。
- 既有可写 workspace/temp 根不重复声明；拒绝 symlink 逃逸。macOS 使用每子进程 Seatbelt；Windows 使用独立 managed-state SID，两端复用同一目录定义。
- Python 默认 DB 在 `db/lxeskill/`。本次审计发现原迁移整库复制、普通 CLI 启动扫描旧库两处边界问题，已修正为实际数据库访问时按目标迁移。
- 旧 `db/lxeskill.sqlite3` 或 `db/local_agent.sqlite3` 仅迁移当前三张 Python 自有表：`ziniao_store_sessions`、`yacang_submissions`、`yacang_cooldown`。不读取/复制 Bun 表内容或未知表，不打开 `db/agent.sqlite3`。
- 只处理当前访问的默认目标；自定义 `LXE_SQLITE_DB_PATH`、list/describe/doctor/help 不扫描无关旧库。
- 使用只读事务保留已提交 WAL 数据，目标完整性检查后同目录原子不覆盖发布；旧文件保留，失败不发布目标，实际需要的损坏旧库仍返回真实异常。
- 雅仓 state.py 仅调整 DB 路径和访问时的迁移挂接，不改变业务执行或数据表。

## 修改文件范围

- Runtime permissions：boundaries、exec-sandbox、execution-paths、managed-python-state；现有 lxeskill-command 和 coding exec/process/public-types 适配；Windows runner/ACL。
- 既有 Desktop/agent-cli 的 Python 路径注入、input-assets、runtime-state、synthetic-performer；qualify-desktop-data。
- Python：shared/db/sqlite/{engine,migrate}.py、shared/db/relocate_data.py、services/yacang/state.py。
- 对应 sandbox/temporary/coding/Desktop/Python migration/relocation/Yacang 测试。
- AGENTS.md 仅 Python DB 位置，数据库/权限/目录/native 说明及既有计划。
- 原 CLI 启动迁移已完全移除，lxeskill/cli.py 与 main 一致，不再纳入 PR1。

## 修复后的验证（2026-10-08）

- 新测试先复现 9 个失败，修复后迁移与 relocation 18 passed。
- pool-22 四平台 + infra + CLI fixture：590 passed、2 skipped、4 既有 aiohttp warnings。混合旧库、WAL、损坏无关旧库、自定义路径、真实访问触发、纯 Bun 旧库跳过及并发目标不覆盖均覆盖。
- pool-22 Bun：58 passed、0 failed、330 assertions，7 个文件；覆盖真实 macOS exec/Seatbelt/Python bootstrap、受限普通命令、Skill/catalog、Desktop 状态与 Gateway 文件顺序。
- pool-22 workspace typecheck：8 个工作区通过。其余层 TypeScript 未变，前轮 typecheck 结果保持；本次未重复无关 build/全量 Bun。
- CLI bootstrap 使用无效参数阻断业务 dispatch，不当作生产导出证据。上述测试没有生产导出/login 请求。
- 修复后逐层只读 patch、diff/check、空索引/冲突和原分支保护检查，见仓库外 evidence JSON。

## 服务、环境与限制

- 当前组合服务为 pool-22 / `codex/pr4-yacang-compat`，正式页面 `app://lxe/`，最近一次授权重启 gateway boot 为 `ecc2bbe135d94c708b480f1f118485fc`，36 个 Skill / 0 diagnostics，Gateway 与 Python CLI 均就绪；pool-18 旧测试服务已停止。提交同步阶段不打断服务。
- 启动组合服务时复用本机已有配置、配对 machine identity 和上马持久认证；只改忽略的 workspace 设置，不复制旧 Bun DB、会话、transcript、任务、产物或 venv。凭据未进入测试、日志输出或 Git。
- 用户已确认组合服务测试通过；独立检查到雅仓 read → exec → send_files、4 模型/3 Tool。这是本次迁移收敛前的实测，修复后未重新执行生产导出；其他平台实测来自用户确认。
- 沿用 LXE_DATA_ROOT、LXE_SQLITE_DB_PATH、LXE_WORKSPACE_ROOT；无新增业务变量，可信宿主定义状态根。测试只注入既有 Node/fd 路径。
- 未修改 Skill/Contract、catalog schema、四平台 Workflow、Shangman 认证/生产门禁、XLS/XLSX 交付、send_files、Runtime Step Loop、Cloud 权限或 Gateway 调度。
- Windows-native ACL、安装包与 Excel/WPS 使用：**NOT VERIFIED**。验收快照阶段真实父链未建立；本次已授权交付必须在同步前通过真实 parent、增量范围与 merge-tree 检查。检查结果以仓库外交付记录为准。
- 原 PR1 acceptance 报告已合并到本文件，不再保留第二份重复交接。

## PR 依赖与下一步

PR1 公共修复 → PR2 TMS → PR3 上马 → PR4 雅仓，主仓 Review 串行。受控暂存/commit、父链建立及本地 origin 同步已获用户授权；先验证实际父链和 merge-tree 再正常推送，不 force push。GitHub push/线上 PR 创建仍需另行确认。每层进入 Review 前按当时 main 再核对，不机械整体同步。
