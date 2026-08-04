# Workspace Instance 与指令缓存

状态：Current

## 先说结论

Session 保存自己不可变的 `WorkspaceContext`，但同一个 Git worktree 下的 Session 不会各自重复加载 Skill、Instructions 和搜索服务。Runtime 用规范化后的 worktree 路径找到一个进程内 `WorkspaceInstance`，再按 Session 的 `directory` 生成当前视图。

缓存只用于加速，不是新的事实来源。退出 `agent-cli` 后缓存全部消失；下次使用时从本机文件重新建立，不写磁盘解析缓存，也不写入 Session `source`。

## 一次 Turn 如何使用

Runtime 从 Agent store 读取 Session，验证 Job 携带的 Workspace 完全一致，并确认原目录仍然可用。之后取得一个 Workspace Lease：

1. 固定本轮的 Skill、`AGENTS.md`、`SOUL.md` 和搜索服务。
2. 用同一个 Snapshot 生成 System Prompt、工具暴露和文件搜索。
3. 文件变化只会生成下一代 Snapshot，不会改变正在运行的 Turn。
4. Turn 完成或失败后释放 Lease。

同一 worktree 的不同 `directory` 共用核心 Instance，但 Instructions 视图不同。Runtime 只读取从 worktree 根到当前 directory 沿途的 `AGENTS.md`，按根到近处排列；不扫描当前 directory 以下的规则文件。

## 自动刷新

Runtime 用文件监听快速发现 `AGENTS.md`、Skill、`SOUL.md` 和连接器状态变化。事件先标记缓存过期，经过短暂防抖后在旁边重建 Snapshot，成功后一次性替换。

文件监听不是正确性的唯一依赖。每次 Turn 取得 Lease 前还有节流后的 size、mtime、inode/file-id 指纹检查；监听器漏报或平台不支持递归监听时，下一轮仍能发现变化。内部 Dashboard 诊断接口可以强制读取正文，用于排查时间戳和 watcher 异常，但产品不向用户提供 reload 命令或按钮。

刷新失败时，有旧 Snapshot 就继续保留并在 Health/日志中告警；第一次加载没有可用旧版本时，本轮明确失败。Session 原目录已经删除或 Git worktree 发生变化时，不能靠旧缓存继续运行，也不能回退到新的默认工作区。

## 内存与回收

安装 Skill 和用户 Skill 的完整正文由全局 SkillCatalog 保存一份。Workspace 视图只引用筛选结果和渲染后的 Prompt，不复制整套 Skill 正文。

Instance 默认最多保留 32 个，空闲 30 分钟后可回收。正在被 Turn 使用的 Instance 不会回收；Runtime 停止时统一关闭 watcher 并清空所有 Instance。Workspace 搜索服务跟随 Instance 生命周期，后台进程仍由 Session 隔离的 Process Manager 独立管理。

## 持久化边界

| 范围 | 保存内容 |
| --- | --- |
| global | Desktop 配置、Secrets、Provider、MCP、连接器设置 |
| window | Dashboard 语言与窗口内导航偏好 |
| workspace | 只有进程内 Instance，不落盘 |
| session | WorkspaceContext、消息、Turn、pending event、exec 进程归属 |

内部强制刷新入口是 Dashboard RPC `sessions.workspace.reload`，输入只包含 `session_id`。它只能通过 Session 找到已绑定 Workspace，不接受调用者提交目录。
