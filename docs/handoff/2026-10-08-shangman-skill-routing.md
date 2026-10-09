# 上马印尼路由交接

## 分支、完成范围与入口

- 当前累计层：`codex/pr3-shangman-compat`，pool-21，依赖 PR2（及 PR1 公共状态修复）。
- 原 `codex/shangman-skill-routing` / pool-13 / `e57801e1` 保持 clean；main 基线 5f785341。
- “上马”“上马印尼”统一指印尼，不追问国家；其他国家不列为上马候选，也不启动上马登录。
- 入口：自然语言 → shangman-goods-export → lxeskill shangman export run；login_required 按既有 shangman-login 恢复，再返回导出；terminal.files → send_files 交付一份原始 XLSX。
- Credentials、AuthStore、GoodsExporter、persisted authentication、credential revision 和生产门禁均沿用 main；有效 token 的正常导出不碰验证码。
- “最多恢复一次”仍是 Skill/Agent Contract，未新增 Runtime 跨回合计数器、Broker、captcha_channel 或旧 challenge 恢复。
- 既有桌面凭据/环境注入不变，无新增变量或真实凭据入 Git。

## 本层文件与语义融合

- skills/shangman-goods-export/SKILL.md
- skills/shangman-login/SKILL.md
- skills/southeast-asia-replenishment-workflow-map/SKILL.md
- packages/agent/runtime/test/tooling/skills.test.ts
- docs/harness/skill/current_skill_catalog.md
- 本交接；原独立 acceptance 报告已合并。

共享的商品 Skill、流程入口和测试保留 TMS 菲律宾与上马印尼双方规则、全部对应断言及旧名清理；不用 ours/theirs 覆盖。

## 验证与限制

- 旧上马描述先触发印尼断言失败；融合后 PR3 Skill/catalog Bun 22 passed、121 assertions，workspace typecheck 通过。
- 组合 pool-22 最新修复后 Python 590 passed / 2 skipped、Bun 58 passed、8-workspace typecheck 通过。fixture 不调用生产导出/login API。
- 用户确认 pool-22 组合服务通过；本轮迁移收敛后未重新执行生产导出。上马实测由用户确认，不把字符串/fixture 测试宣称为模型现场测试。
- 当前组合服务为 pool-22，旧 pool-18 已停止，本轮不重启服务。
- 业务 Workflow、认证、command ownership、生产门禁、send_files 和 terminal 语义零改动，PR1 迁移修复原样继承。
- Windows-native/安装包/Excel/WPS 仍 NOT VERIFIED；快照验收时父链尚未建立；当前已授权交付须在同步前通过 parent/增量/merge-tree 检查，最终结果记录在仓库外交付资料。

## Git 与下一步

2026-10-08 四层为未提交快照；2026-10-09 已获受控提交、父链建立和本地 origin 同步授权。原业务分支保留；先检查真实增量/父链/merge-tree，再正常同步本地，不 force push。GitHub/线上 PR 未授权。主仓 PR1 → PR2 → PR3 → PR4 串行 Review；PR2 合入后按当时 main 检查本层共享语义，不机械全链 merge/rebase。
