# 马帮 TMS 菲律宾路由交接

## 分支、完成范围与入口

- 当前累计层：`codex/pr2-mabang-tms-compat`，pool-20，依赖 PR1 公共 CLI 状态修复。
- 原独立分支 `codex/mabang-tms-skill-routing` / `cb07ec4a` 保持 clean；基线 `upstream/main` / `5f785341`。
- 只改命名/国家路由：活跃 Skill 移除旧 TMS 名称；马帮 TMS 未写国家时按菲律宾理解，其他国家不列为候选。
- 入口：自然语言 → Skill discovery → mabang-tms-export → lxeskill mabang-tms export run → terminal.files → 一次 send_files。
- 保留 main 的账号可见全仓、单次导出、合并文件、部分成功与认证/CLI 实现；国家边界由 Skill 指令约束，不是新增 CLI 筛选。
- 沿用 LXE_MABANG_TMS_ACCOUNT / LXE_MABANG_TMS_PASSWORD；无新环境变量或真实凭据入库。

## 本层文件

- skills/mabang-tms-export/SKILL.md
- skills/shangman-goods-export/SKILL.md：只清理旧 TMS 名称。
- skills/southeast-asia-replenishment-workflow-map/SKILL.md
- packages/agent/runtime/test/tooling/skills.test.ts
- docs/harness/skill/current_skill_catalog.md
- docs/harness/skill/mabang-tms-export-validation.md
- 本交接；原独立 acceptance 报告已合并到此处。

## 验证与限制

- 路由测试先失败后通过；PR2 层 Skill/catalog Bun 22 passed、112 assertions，workspace typecheck 通过。
- replenishment 下相关 15 个 Skill 可发现，旧 amazon_replenish 下为 0；36 个活跃 Skill 扫描无旧名。
- 组合 pool-22 最新修复后 Python 590 passed / 2 skipped、Bun 58 passed、8-workspace typecheck 通过；fixture 不调用生产导出/login API。
- 用户已确认 pool-22 组合服务通过，这是最新迁移收敛前的实测；本轮没有重新执行生产 TMS 导出，不以字符串断言代替自然语言实测。
- 当前服务确为 pool-22，不是旧 pool-18。启动复用的本机配置/身份均在忽略目录，未入 Git 或 fixture。
- 本层未改 Runtime、Cloud、Workflow、CLI/schema、认证或文件交付。PR1 迁移修复原样继承。
- Windows-native ACL/安装包/Excel/WPS 仍 NOT VERIFIED；快照验收时父链尚未建立；当前已授权交付须在同步前通过 parent/增量/merge-tree 检查，最终结果记录在仓库外交付资料。

## Git 与下一步

2026-10-08 四层为未提交快照。2026-10-09 已获受控提交、父链建立和本地 origin 同步授权；原业务分支/提交保留。先验证增量与父链，再正常同步本地，不 force push；GitHub/线上 PR 未授权。Review 顺序 PR1 → PR2 → PR3 → PR4；PR1 合入后按当时 main 复核本层，不整文件覆盖共享 Skill/测试。
