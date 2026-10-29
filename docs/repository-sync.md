# Mac 与 Windows 仓库同步

GitHub 的 `main` 是共同基线。默认在 Mac 开发；Windows 用于平台相关开发、桌面实机验收和打包。打包机器不维护另一套长期独立的源码。

## 换机器前后

1. 开始前检查工作区、当前分支，执行 `git fetch origin`，比较本机 `main` 与 `origin/main` 的提交。工作区有改动先保留，不能覆盖。
2. 本机没有独有提交时，使用 `git merge --ff-only origin/main` 同步。已经分叉时，先在领取的 worktree 内整合双方成果，再开发。
3. 按 [AGENTS.md](../AGENTS.md) 在任务分支开发、验证、提交和推送，创建目标为 `main` 的 PR。每个 worktree 使用自己的依赖环境；任务已提交并推送后可归还槽位，保留分支等待审核。
4. PR 完成审查并在远端合并后，各机器 fetch 并快进同步本地 `main`，核对完整提交 ID；交付时注明哪台机器已经同步、在哪个平台完成了哪些验证。

## 历史整合记录

早期 Mac／Windows 分叉整合的提交、处理和验证范围见 [历史记录](record/repository-sync-integration.md)。日常验证按改动的实际影响范围执行，遵循 [AGENTS.md](../AGENTS.md#工具链)。
