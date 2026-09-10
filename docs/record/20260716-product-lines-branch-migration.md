# 产品分支边界

决策日期：2026-07-16。当前开发和打包入口见 [Desktop 技术手册](../desktop/README.md)。

- main 是 Electron Desktop 产品线，负责桌面会话、Main/Renderer、私有 Agent CLI、运行资源和 Windows NSIS 分发。macOS 源码开发和预览也在此分支。
- lxe-agent-TUI 是独立源码终端产品线，其终端启动器、浏览器 Dashboard 和安装方式以该分支 README 为准。
- 两条分支保留独立产品历史，公共修复按需选择性移植，不通过整体 merge 或 rebase 保持同步。

main 中保留的旧源码安装脚本默认获取 lxe-agent-TUI，供历史安装 URL 继续使用。开发 Desktop 应按桌面手册安装当前 checkout 的 Bun/uv 依赖，不使用这些 TUI 安装脚本。

main 同样提供显式调用的 [一次性 Agent CLI exec](../harness/runtime/agent_cli_exec.md)，不要求切换产品分支。每份源码 checkout 和 worktree 各自维护 .venv；分支划分不改变这条依赖隔离规则。
