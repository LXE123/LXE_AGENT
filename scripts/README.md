# 开发脚本

开发规则见 [AGENTS.md](../AGENTS.md)，审查要求见 [PR 审查规范](../docs/pr-review.md)。

## Worktree 池

`wt-claim` 复用当前本地仓库的 `.worktrees/pool-N` 目录。默认有 4 个槽位，用于同时开发的任务；待审 PR 可以保留分支并归还槽位。每个槽位使用自己的依赖环境，领取时同步 Bun 和 uv 依赖，不共享或复制 `.venv`。

在仓库中执行，任务名使用 kebab-case，例如 `fix-store-lock`。

macOS / Bash：

```sh
scripts/wt-claim fix-store-lock
scripts/wt-claim status
scripts/wt-claim release fix-store-lock
```

Windows PowerShell：

```powershell
scripts/wt-claim.ps1 fix-store-lock
scripts/wt-claim.ps1 status
scripts/wt-claim.ps1 release fix-store-lock
```

领取命令输出的最后一行是任务工作区路径；新任务使用 `codex/<任务名>` 分支。已有同名任务分支时会重新挂载，保留其提交，继续处理同一个 PR。

完成修改、验证、提交和推送并创建 PR 后，可以归还槽位。`release` 要求工作区干净，将槽位切回本地 `main` 的 detached HEAD 并清除占用标记，保留目录、依赖和任务分支；不删除本地或远端分支，也不合并或关闭 PR。脚本不检查是否已推送，归还前需自行确认。

收到修改意见后，再领取同一任务名即可继续。合并后的分支清理由维护者单独处理，不与归还槽位绑定。不要手动删除池中的 worktree。

槽位全部占用时，先归还已经完成提交并推送的任务；确需扩大并行开发数量时，在当前终端设置上限，再执行领取、查看和归还命令：

```sh
export WT_POOL_MAX=6
```

```powershell
$env:WT_POOL_MAX = 6
```

操作扩容后的槽位时使用相同上限，确保脚本能找到它们。

### 测试配置

领取或恢复任务时，依赖准备完成后会检查该槽位的测试配置。以下四个文件都不存在时，从主工作区初始化；其中任何一个已存在，就整组保留，避免把一份账号配置与另一份密码混在一起：

- `var/config/settings.json`：账号、模型选择、路径等设置。
- `var/config/secrets.bin`：Electron 加密保存的业务密码和公司凭据。
- `var/config/auth.json`：个人模型 API Key。
- 根目录 `.env`：源码开发使用的集成凭据。

配置属于槽位，归还或换任务后仍然保留，不会持续与主工作区同步。需要换成主工作区的最新配置时，先关闭该 worktree 的桌面应用，再显式刷新：

```sh
scripts/wt-claim refresh-config fix-store-lock
```

Windows 使用 `scripts/wt-claim.ps1 refresh-config fix-store-lock`。命令只接受当前已领取的任务；不重新安装依赖，也不切换分支。刷新前会将已有的四个文件备份到 `.worktrees/pool-N.config-backups/`，并输出本次备份目录。刷新按主工作区快照替换这组文件，源端缺失的文件会从目标移除；如果源端四个文件全无，则保留目标并提示未作修改。

`settings.json` 中指向主工作区内部的工作区、产物和紫鸟程序路径会改为对应 worktree 路径；外部绝对路径保持原样。脚本不会复制这些路径下的业务文件，也不会改写 `.env` 的内容。会话数据库、登录态缓存、日志、输入资料和业务参数不在这次初始化范围内。

加密凭据由离线 Electron 进程读取、重新加密并验证，使用当前操作系统账号和 worktree 自己的加密环境；不替换目标已有的密钥，不启动应用业务服务。凭据明文只在内存中处理，临时交接文件使用一次性密钥加密，用完即清理。凭据不可读取、配置正在被修改或目标桌面仍在运行时，会显示错误并保留原配置；已领取的槽位可直接用同一任务名重试。

这些配置仍然指向原先的账号和外部系统。独立测试配置隔离的是本地配置修改，不会自动生成测试 ERP 或测试账号。主工作区没有配置时，其他维护者仍可正常领取槽位，之后自行配置。

定向验证：`bun test scripts/wt-claim.test.ts scripts/worktree-config.test.ts`。需要验证操作系统加密存储时，设置 `LXE_TEST_CREDENTIALS=1` 再执行同一命令；该测试仅使用临时目录和虚构凭据，需当前机器可运行 Electron 并访问安全存储。
