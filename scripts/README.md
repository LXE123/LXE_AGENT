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
