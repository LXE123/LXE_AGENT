# Windows 更新与发布

正式版：Windows x64。连接公司网络后自动检查，每 10 分钟约 ±20% 错峰，失败退避至最多 1 小时。发现新版本后由用户点击下载；安装前再次确认。普通退出不安装，当前不提供强制更新。

## 准备和构建

编辑 `config/desktop-release.json` 的版本和说明，并提交源码。首版从 0.2.17 开始，不补录 0.2.16。版本号由发布者决定；开发构建不自动推进正式版本。

在 Windows 仓库根目录运行：

```powershell
git pull --ff-only
bun run release:build
bun run release:publish
```

`release:build` 检查干净源码和版本说明，安装冻结的 Bun/Python 依赖、准备 fd，执行一次完整源码验证，再生成一次 NSIS 安装包。它不拉取、提交或推送 Git，也不自动递增版本。

每次构建开始，`dist/desktop-candidates/current.json` 先变为 `building`，使旧候选不可被默认发布。只有整个流程成功才变为 `ready`，保存源码提交和候选相对路径；失败为 `failed`，中断可能保留 `building`。这些状态都不会自动回退发布旧包。历史安装包按下文规则清理，记录继续保留。

生成的 `dist/desktop-candidates/<build-id>/candidate.json` 记录源码提交、独立构建编号、大小和 SHA-512，旁边保存固定安装包和 `.exe.blockmap`。构建编号在打包前生成，连同源码提交号写入安装包，候选记录沿用同一编号。未发布版本可修改源码、提交后重打；每次获得新构建编号。

## 本地安装包保留

每次成功构建或成功发布后，自动清理本地候选目录中的旧安装包：

- 保留最近 3 次成功构建的安装包，按候选记录的构建时间排序。
- 额外保护最近 1 次成功发布的安装包；它在前 3 个里时不重复计算，通常共保留 3–4 个。
- 当前候选及本次刚完成的候选始终保留。单独打包产生更多候选时，当前候选可能使保留数量额外增加。
- 成组删除符合候选记录的 `.exe` 与 `.blockmap`；`candidate.json`、`publication.json` 等记录一直保留。失败、中断、取消发布不触发清理。

`last-published.json` 在正式渠道更新成功后才写入，用来标识最近成功发布的候选。`publication.json` 在上传前就可能存在，不能单独证明发布成功。首次使用新规则时，旧版本留下的发布记录无法确认成功与否，因此暂时保护这些包；下一次成功发布建立明确记录后，旧包再按普通规则清理。

清理与上传共用候选目录的 `retention.lock`，避免删除正在上传的包。清理遇到锁、记录损坏或文件占用，会报告实际原因并跳过，不把已经成功的构建或发布改成失败。异常退出遗留该锁时，同样先确认相关进程已停止再手动移除。

历史记录仍可追溯源码，但安装包被清理后不能直接用该记录重新上传。本规则只管理本地候选安装包，不清理 COS，也不清理 `dist/desktop` 的打包输出或运行时缓存。

## 发布与暂停

检查安装包后运行 `release:publish`。它核对当前工作区干净、源码提交/版本/说明与当前候选一致，以及安装包和 blockmap 的大小、SHA-512；随后显示版本、时间、提交、说明、大小。输入 `y` 才上传并激活正式渠道，再记录 GitHub Release；其他输入取消，非交互终端拒绝发布。确认后再次校验，避免等待期间发生变化。

构建后再次修改代码或 `git pull` 得到新提交，默认发布要求重新构建。上传失败可重试同一命令；`Published ...` 表示 COS 渠道发布成功，随后 `GitHub Release: <地址>` 表示 GitHub 记录完成。发布不会删除当前候选，重复发布同一构建沿用既有幂等规则。

Windows 发布机需安装 [GitHub CLI](https://cli.github.com/)，执行一次 `gh auth login --hostname github.com`，登录对仓库有发布权限的账号，并提前将候选包对应的源码提交推送到 `origin`。脚本从 `origin` 的 GitHub 地址确定仓库，不自动推送源码。构建命令不依赖 GitHub CLI。

COS 发布成功后，`release:publish` 自动创建 `v<版本号>` 标签和同名 GitHub Release。版本号与正文沿用已校验的候选记录（来自 `config/desktop-release.json`），标签指向候选包的 `source_commit`，不会使用当时最新的 `main`。安装包和 blockmap 继续只上传 COS。已有同标签、同源码提交的正式 Release 直接复用，保留人工编辑过的说明；标签指向其他提交或已有记录仍是草稿/预发布时，报错并留给发布者处理，不移动标签或覆盖记录。

如果 GitHub 创建失败，命令以非零退出码明确报告“COS 已发布成功”，保留实际错误。客户端仍可更新，不回滚 COS。修复 GitHub CLI 登录、网络、权限或源码未推送的问题后，在源码和候选保持不变的情况下重跑 `bun run release:publish` 即可补建；不需要为了补记 GitHub 重新构建或升级版本。请求返回前断线时也可这样重试，已创建的 Release 会被复用。

同一工作区用 `dist/desktop-candidates/workflow.lock` 防止两个新入口并发。异常退出遗留锁时，先确认构建或发布进程已经停止，再手动移除该锁；不要在另一流程仍运行时删除。

旧入口仍有明确用途：`verify:platform:win` 是 `release:build` 的兼容别名；`desktop:dist:win` 只打包，不更新默认待发布记录。需要显式选择历史候选包时使用高级入口（仅发布 COS，不自动创建 GitHub Release，仍遵守渠道版本冻结和文件校验）：

```powershell
.\scripts\publish-desktop-windows.ps1 -Candidate 'D:\projects\LXE_AGENT\dist\desktop-candidates\<build-id>\candidate.json'
```

凭据从当前 Windows 用户的 `%LOCALAPPDATA%\LXE\release\cos-credential.xml` 解密，只经标准输入传给发布工具，不进入命令行、源码或安装包。不要在其他电脑复用此加密文件。

上传顺序：安装包和 blockmap → 按构建编号保存的不可变版本记录 → 正式渠道指针。每个产物上传后都检查对象大小和摘要元数据，再流式回读实际内容计算 SHA-512；仅靠上传者提供的元数据不算校验通过。回读失败或内容不一致时不能切换渠道，发布凭据需要具有这些对象的读取权限。客户端只认渠道指针。渠道切换前失败的文件是未发布候选；可重试同一包，也可换候选包。发布成功后，同版本不能替换构建；修复需要新版本。

本期只使用一台 Windows 发布机。发布锁位于凭据目录的 `publish.lock`；如果进程意外退出，确认没有发布进程后再手工删除该锁。不同机器并发发布不在本期支持范围内。

```powershell
.\scripts\publish-desktop-windows.ps1 -Action pause
```

暂停保留最后发布版本作为版本下限，不降级。重新发布同一个候选可恢复；发布更高版本也可恢复。已发放的临时链接在到期前仍有效。不要手工编辑 COS 渠道文件绕过发布规则。

COS 布局：

- `artifacts/<version>/<build-id>/LXE-Agent-<version>-windows-x64.exe`
- `artifacts/<version>/<build-id>/LXE-Agent-<version>-windows-x64.exe.blockmap`
- `releases/<version>/<build-id>/release.json`
- `channels/stable/windows-x64.json`

## 客户端行为

检查只展示更新说明，不申请下载链接。下载与安装请求绑定版本和构建编号；新的发布不会继承旧提示中的确认。下载失败可以重试下载，安装准备失败可以重试安装，也可重新检查版本。

私有分发继续使用公司 WireGuard 设备身份。安装前、用户完成确认后，都会重新核对设备权限和正式渠道。主进程确认中断任务后，锁住新任务和终端入口，等待已接收的任务完成入队；若出现用户尚未确认的新任务，会再次询问。随后清理队列、停止运行任务和应用拥有的子进程，确认实际退出才启动安装器。外部紫鸟客户端不属于这次清理范围。安装器启动失败时，桌面仍在则尝试恢复服务；无法确认旧进程退出时禁止启动另一份运行时。已取消的任务不重放。

## 差分与缓存

更新服务分别给安装包、新 blockmap 和旧 blockmap 签发有效期 600 秒的链接，客户端不能通过替换 URL 文件名来拼接链接。服务端一次请求计一次签发配额。客户端复用当前锁定版本 electron-updater 的差分算法，使用单区间 Range 请求，并保留最终 SHA-512 与已有发布者签名校验。

安装成功后将安装包缓存到 `%LOCALAPPDATA%\lxe-agent-updater\installer.exe`。更新下载保存在同一缓存下的 `pending`。差分开始前按已安装的构建身份核对缓存；缓存被删除或损坏、历史 blockmap 缺失、服务器不支持 Range 时，记录实际原因并完整下载。过期对象链接最多自动重新签发一次；权限、限流和最终校验错误不会无限重试。日志不保存签名 URL。

## 安装与失败恢复

安装器先在安装目录旁完整解压新程序，再检查必需文件和 Office 前置依赖。已有安装固定在原目录更新；安装目录内若存在旧 `var/`，也原地保留。当前用户数据位置与旧目录迁移见 [程序与用户数据](data-location.md)。程序文件按事务记录移入旁边的备份目录，然后替换成新文件；提交前失败会尝试恢复旧程序。回滚失败保留备份和实际异常，诊断文件位于 `%TEMP%\lxe-update-<事务编号>.log`。新程序安装成功后才替换缓存，缓存写入失败不会撤销已完成的安装。

实际数据目录下的 `updates/last-attempt.json` 记录应用发起的安装尝试；下次启动同时核对实际版本和构建编号，再展示结果。这里恢复的是安装阶段的程序文件，不提供断电后的自动恢复、新版本启动健康检查、数据库回滚或自动降级。

## 部署与验证

先部署支持可选 blockmap 字段的更新服务端，再发布新的候选记录；旧服务端会拒绝未知字段。不支持差分的旧客户端仍走完整下载，升级到支持差分的版本后才可使用差分。服务器保留历史 blockmap，本地候选保留策略不清理 COS。

定向测试覆盖更新操作与确认、任务接收竞态、私有协议兼容和真实 HTTP Range 差分。Windows 验证在独立工作区从仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-update-files.ps1
bun scripts/qualify-desktop-update-installer.ts <win-unpacked目录> <旧版本Git提交>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-update-installers.ps1 -Qualification <qualification.json>
bun scripts/test-update-download.ts <qualification.json>
bun scripts/test-update-extraction.ts <已缓存的makensis.exe路径>
```

构建夹具生成旧版 ZIP 与两个新版 7z 安装包，共用一个随机测试 AppID 和安装缓存；这个身份与正式应用隔离。原生下载测试另外使用自己的缓存，避免覆盖安装测试的缓存。安装路径包含中文和空格，但保持较短，以兼容旧 ZIP 解压器的路径长度限制。测试包的隧道清理脚本替换为无系统操作的夹具，不能发布这些测试包。

历史结果见 [2026-10-06 验证记录](../acceptance/desktop-updates-validation-20261006.md)。[2026-09-21 记录](../acceptance/desktop-updates-validation-20260921.md) 描述的是旧实现。正式发布仍走现有发布者确认流程。
