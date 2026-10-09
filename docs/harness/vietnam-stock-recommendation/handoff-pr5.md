# 越南备货受信 SKU 与 Desktop 设置交接

- 分支：`codex/vietnam-clean-pr5-desktop`；worktree 由 `scripts/wt-claim vietnam-clean-pr5-desktop` 领取。
- 基线：新 PR4 `9db9fc89b93a508d12c94f8e5963cbfc7d56c973`。
- 内容：Python 受信 SKU current/previous、候选校验、内容摘要、幂等安装和回滚；Desktop 原生文件选择与受控 IPC；工作台 SKU 资产管理；雅仓设置内的越南长期四参数；在线 Workflow 读取这些设置。旧模板槽只作兼容。
- 文件范围：Desktop/Dashboard 设置和资产视图、IPC/协议及测试；Python 资产存储、CLI、Workbook/Workflow 接线及测试；Vietnam Skill、资产契约、本交接页和 Desktop 设计规格。完整文件范围以 `git diff --name-only 012f4915..HEAD` 为准。
- 调用链：Desktop 原生选择器 → 固定 SKU 安装命令 → Python 校验/受信版本存储 → `current` 私有快照 → 在线 Workflow → Workbook/Office/Validation；长期四参数由 Desktop 保存并经环境注入，Python 在导出前校验。新增环境变量：`LXE_VIETNAM_WEIGHT_30D`、`LXE_VIETNAM_WEIGHT_15D`、`LXE_VIETNAM_WEIGHT_7D`、`LXE_VIETNAM_EXCHANGE_RATE`。不写入凭据。
- 兼容处理：旧 Desktop 提交与最新 main 在 `apps/desktop/src/main/input-assets.ts`、`apps/desktop/test/preload-bridge.test.ts` 重叠。合并后保留 main 的 `LXE_WORKSPACE_ROOT` 注入及工作区桥接测试，同时加入通用资产命令执行和 SKU 管理测试。
- 验证：Python 越南/CLI/catalog/infra 定向测试 594 passed、5 skipped；相关 Desktop/Dashboard Bun 测试 132 passed；Desktop/Dashboard TypeScript typecheck 通过。前序 PR3 内部校验修正传播后，越南模块定向重跑 200 passed、3 skipped。全部采用合成文件/本机模拟，未调用生产雅仓。
- 已知边界：生成时仍要求完整 SKU 映射，缺行与空价格由新 PR6 单独修正；聊天直接绑定与 Skill 预选由新 PR7 接线。真实 Windows 安装版与生产雅仓连通性不在本机验收范围。
- 依赖与下一步：新 PR6 基于本分支处理稀疏映射及公式校验。本层只本地提交，未 push 或创建新 PR。
