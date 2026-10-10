# 会话权限与工作区目录

桌面端已开放 Read Only、Workspace Write 和 Full access。权限约束覆盖 `exec`、`write`、`edit` 的本地文件写入；读取、搜索、网络、MCP 和外部平台操作继续沿用原行为。Windows 后端沿用 DSH 的部分写入隔离，具体限制见下文。

## 模式与生效时机

| 模式 | 本地文件写入 |
| --- | --- |
| `read-only` | 受控操作不允许修改普通文件，包括临时文件 |
| `workspace-write` | 允许固定工作区和平台指定的临时区域 |
| `danger-full-access` | 不施加这套文件沙箱，操作系统原有权限仍适用 |

Bun 的 `agent_sessions.permission_mode` 是唯一属主。新建普通会话和空白会话显式保存 Workspace Write；旧数据库补列仍初始化为 Full access。恢复、再次收消息、更新元数据和复用空白会话都保留原模式。Python 不访问 Agent DB，模式也不进入 `source` 或工具 `state_patch`。

`sessions.permission.set` 校验并保存模式，返回实际保存值，通过 `session.changed` 通知所有窗口。输入区选择器在回合运行或等待提问时仍可使用；审批卡显示期间隐藏输入区及工具栏，待审批项处理完后恢复。选择 Full access 需要确认。界面以服务端状态为准，重连重新查询，切换会话不会应用上一会话晚到的响应。

每次模型请求（包括重试和压缩之后）以及每次工具调用开始时，都读取最新模式。一次调用取得不可变策略快照，排队和审批期间不改用后来的会话模式。已经启动的进程及其后代保留原策略；切换模式不取消它们，也不撤销已发起的审批。

环境上下文包含模式、固定工作区、平台临时区域说明和有无单次审批渠道。这些字段参与环境变化检测、transcript 保存与恢复；旧记录缺少字段时正常兼容。

## 轻策略与路径属主

`PermissionPolicyService.resolve` 只返回模式、固定 `workspace.directory` 和会话 ID，不访问文件系统、不创建目录、不审批、不修改会话。边界不扩大到 Git 根或命令 cwd；`workspace.worktree` 仍用于指令加载、Git 和开发环境 `.venv` 定位。

`ExecutionPaths` 单独推导产物、命令输出和临时路径，不提前访问或创建产物目录。工作区里 `.lxeagent` 是普通文件时，只在实际使用其产物目录的操作上报错。移除了对数据库、日志、配置等目录的统一真实路径诊断和重叠拒绝；选整个项目作为工作区时，其中的应用私有文件也进入工作区写入范围。

下表的 `var` 是宿主配置的 `LXE_DATA_ROOT`；默认工作区仍是 `var/workspace/`。

| 路径 | 属主和用途 |
| --- | --- |
| `var/db/` | Bun Agent DB、transcript；Gateway DB；Python 自有 DB，各自管理 |
| `var/config/`、`var/logs/` | 宿主及服务的配置、凭据和日志 |
| `var/inputs/`、`var/lxeskill/` | 长期素材和 Python CLI 内部状态，不随产物迁移 |
| `var/cache/`、`var/electron/` | 预览缓存与桌面状态 |
| `var/tmp/exec/<session hash>/` | Bun 宿主保存命令输出，不依赖 Git 根或 cwd |
| `<workspace>/.lxeagent/artifacts/` | 当前工作区产物，按现有业务模块和数据集结构组织 |

同工作区的会话共享产物，不同工作区不自动共享。模型的 `artifact_root`、文件工具目录识别与 Python 实际输出使用同一规则。子进程 `LXE_WORKSPACE_ROOT` 指向选中的目录；Python 解释器和依赖仍从 worktree 定位。独立 CLI 未指定工作区时使用调用者 cwd，无会话宿主调用显式传入默认工作区。现有 `.lxeskill` 外部 CLI 内部状态接口保留。

宿主命令输出不单独授予工具写权限；如果它本来就在所选工作区或平台允许的临时区域内，就按该区域的普通内容处理。

## 临时目录与执行后端

macOS Workspace Write 开放工作区、`/tmp` 和系统用户临时目录，执行时规范化真实路径并去重。使用系统临时环境，不再创建 `var/tmp/tools` 下的会话目录，也不清理系统共享临时区域。Read Only 不开放这些普通文件写入。

Windows 在系统临时根下使用包含运行时随机 UUID 和会话哈希的专用目录。Bun 缓存同会话初始化的 Promise，并发调用共用一次授权；Node/Koffi 启动器提供内部 `--prepare-session` / `--release-session` 入口。命令启动通过已有 `--write-sid` 和 `--temp-write-sid` 复用授权，不在每条命令结束或模式切换时撤销。不同会话目录和 SID 分离，重启后生成新路径，不复用崩溃残留。

删除会话或关闭运行时时，先结束相关进程和准备任务，再撤销临时授权、清理该运行时的会话临时目录（包括文件工具创建而尚未用于 exec 的目录）。授权或清理失败保留实际错误。工作区 ACL、继承的删除限制和 Low 完整性标签继续持久保留，退出不恢复；这是已经选定的 DSH 行为。Windows 必须保证工作区与其专用临时目录分离。

macOS 使用 `/usr/bin/sandbox-exec`，Windows 使用独立 Node、Koffi 3.1.1 和受限令牌。Desktop 注入 `LXE_EXEC_SANDBOX_NODE`、`LXE_EXEC_SANDBOX_RUNNER`，模型不能选择启动器。源码启动 `bun run desktop:preview` 或 `bun run desktop:dev` 自动准备所需资源；也可用 `bun run desktop:prepare` 只做准备。低层 `bun scripts/prepare-exec-sandbox.ts` 保留供单独维护，打包包含原生依赖和 MIT 许可证。Full access 跳过沙箱和受限授权；后端缺失或失败明确报错，不降级执行。

Windows 仍有 DSH 机制本身的限制：工作区硬链接别名、Everyone 等环境 ACL、Low 标签对其他进程的影响、继承管道和 PowerShell 的兼容性。结果中 `sandbox.enforcement` 标为 `partial`；macOS 标为 `file-write`，Full access 为 `none`。这不是读取、网络或进程可见性隔离。

## 工具检查与单次审批

`exec` 在调用开始记录边界，等待执行名额后、创建目录或应用授权前重新检查。异步授权完成后再次核对取消状态和实际边界，再启动进程。宿主输出、exec/wait、取消和后代终止仍由 Bun 管理。

`write`、`edit` 在任何创建或修改前检查目标真实路径、允许范围和文件状态；受限模式拒绝普通文件的多个硬链接。最终检查重新解析路径和读取版本，随后同步直接写入；沿用会话隔离的先读后改账本，并记录写入后的版本。符号链接和 Windows junction 仅在实际目标处于允许区域时可用。路径检查和写前复查不等于操作系统隔离，也无法完全消除外部进程替换路径的竞争。

三个工具始终提供成对的可选参数 `sandbox_permissions`（Workspace Write 或 Full access）和非空 `justification`。不填则使用会话模式；重复当前模式无需审批；只接受更宽模式的单次请求，不接受降级。模型应选择够用的最小权限。明确的文件策略拒绝给出当前渠道可用的审批指引；普通文件系统和进程错误保留原内容，不一律解释为沙箱拒绝，不自动提权或重跑。

审批只由桌面 `PermissionApprovalService` 接收，独立于普通提问。请求绑定会话、回合、调用 ID、冻结后的完整参数、目标模式和理由。`sessions.approvals` 查询待办，`sessions.approval.decide` 只接受允许或拒绝，不能替换操作。卡片展示目标权限、申请理由，以及命令和 cwd 或文件路径；文件内容和修改前后文本默认折叠，展开后完整可读。多个请求逐项决定，卡片只提供“拒绝”“允许一次”，不提供批量或永久授权。拒绝只针对本次操作；待审批项处理完后恢复草稿、附件及正常停止按钮，需要结束整轮任务时再停止。没有桌面审批渠道时明确拒绝，不无限等待。

批准前不启动进程、不创建目标文件。文件工具批准后重新检查目标身份、版本、硬链接、取消状态和读取记录，等待期间出现、消失或改变的目标拒绝覆盖。批准只释放原调用一次，exec 授权覆盖该进程及后代的生命周期，不改变会话模式。同一决定重复提交幂等，冲突、跨会话和过期决定拒绝。

请求与决定作为 `permission_approval` 内部事件写入现有 transcript，不进入模型普通消息。停止任务、删除会话和运行时关闭取消请求；切换模式不取消。界面重连重新查询仍存活的请求；运行时重启只保留审计记录，旧请求不能恢复执行。

## CLI 的实际写入依赖

`lxeskill` 通过普通 `exec` 执行，沿用上述权限检查和单次审批，不自动改变会话权限模式。CLI 初始化可能创建内部状态、产物、输入目录；日志会写入并清理文件；业务命令可能访问 Python DB、认证缓存和锁文件。同目录的原子替换文件也不受 `TMPDIR` 重定向影响。这些写入不获得隐藏白名单。受限运行遇到工作区外状态写入时保留真实异常，需要时由模型显式申请本次更宽权限。

## 历史数据

Desktop 首次升级启动时，会在 Agent 和 Python 启动之前，把旧 `var/artifacts/` 一次性复制到默认工作区的 `var/workspace/.lxeagent/artifacts/`，保持业务目录结构。已有目标文件优先，只补齐缺失项；目录与文件冲突也保留目标项，不沿目标符号链接写入。此迁移只处理默认工作区，外部工作区不自动导入旧数据。独立 CLI 不触发这项 Desktop 升级迁移。

复制先写入目标旁的专用暂存目录，完整文件就绪后再发布；中断后下次启动重试，不把半个文件当作已完成产物。全部成功后，在 `var/migrations/default-workspace-artifacts-v1.json` 原子记录完成，之后即使删除新产物也不会重新导入旧数据。没有旧目录的新安装同样记录完成，并且不再创建旧全局产物目录。失败时显示实际错误并停止启动，不记录完成；修复原因后重新启动即可重试，无需迁移 UI。

旧目录始终保留，历史附件继续按原绝对路径打开，不修改数据库、附件记录或文件内的路径引用。新业务只使用当前工作区的数据集，不回退查找旧目录，也不自动改名旧业务数据集目录。

## 验证入口

权限策略、审批、临时目录生命周期与原生进程回归在 `packages/agent/runtime/test/permissions/`；文件版本和真实链接回归在 `test/tooling/file-tool-permissions.test.ts`、`edit-tool.test.ts`。Agent RPC 与审计恢复在 `apps/agent-cli/test/permissions.test.ts`，桌面行为在 `apps/dashboard/test/behavior/renderer.test.ts` 的 permissions/composer/readiness 场景。

Windows 真实测试设置 `LXE_EXEC_SANDBOX_NATIVE_TEST=1` 并提供 Node 和已构建的 runner；使用独立工作区及专用夹具，不对真实业务目录修改 ACL。开发只跑相关定向测试和类型检查，最终 rebase 后按仓库要求运行一次 `bun run verify:source`。
