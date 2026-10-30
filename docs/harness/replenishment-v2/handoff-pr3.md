# PR3：业务命令与Skill接入历史交接

> 本文记录PR3技术接入阶段，不是现行执行指引。当前Amazon统一入口及V2命令归属见[PR4交接](handoff-pr4.md)。

## 职责与依赖

- 早期技术分支 `codex/final-restock-skill`（pool-6）；完整PR3为 `codex/final-restock-auto-data`（pool-7），确认HEAD `092b24cc`，依赖PR2 `af0d7b8b`，PR #103。
- 本阶段把PR2生成命令开放为business/exposed，补齐公开输入、标准终态、附件、scope和Skill契约；未在此层重新实现公式或工作簿。
- 最终PR3同时包含自动取数、Desktop设置及原取数Service的最小扩展；具体决策与证据见[自动取数交接](handoff-auto-data.md)。

## 当前状态与归属

- 原独立`replenishment-final-restock` Skill及其owner只代表PR3历史，PR4已删除该Skill。V2计算能力保留，现行命令为`replenish v2 generate`，归属`replenishment-workflow-map`；Desktop配置使用internal命令`replenish v2 settings`。
- V1原计算／销量分析／多Sheet保留；V2使用规范店铺名、同源MSKU、深圳报告及货件快照，35列／14公式由上游实现。
- 三文件来源核验、真实异常、失败附件和标准终态复用CLI／Service；Runtime继续按现有Skill发现与公开`lxeskill list/describe`契约工作。
- PR3原uq122 AG由PR4深圳真实库存整改替代。当前未知库存只允许核对文件及非成功状态，未获运营正式交付批准。

## 关键验证证据（历史，不是本轮重跑）

| 阶段 | 证据 |
|---|---|
| 初始业务命令接入 | CLI/infra502 passed、5 skipped、4 warnings；Bun25 pass。含4 Windows跳过及1项未配置Office跳过，不能报告Office通过。 |
| 2026-10-14正式参数收敛 | 两版命令／参数／scope隔离及真实SkillCatalog回归；模型初始化缺DeepSeek API Key，没有发送模型请求。 |
| PR2后续修复继承 | 公式、文本保真和发布保护通过同一祖先提交继承，不在PR3复制实现；后续90项及完整PR3验证见自动取数交接。 |

## 限制与下一步

- 静态Skill、模拟Service终态和Runtime发现不证明真实模型正确选路；真实模型、Desktop完整聊天、生产ERP、当前附件发送、Windows和Microsoft Excel仍NOT VERIFIED。
- PR3遗留的无效旺季开关、越南CSS耦合和页头复用问题已由PR4提交`af8f298f`修复；pool-11保留为历史补丁来源。后续有效开关、天数必填和聊天优先规则属于PR4在af8f298f之后的旺季交互调整，当前状态及证据见[PR4交接](handoff-pr4.md)。
- 403后认证刷新是原有历史风险，当前PR4未修复；独立网络修复分支的草稿不计入本层已发布能力。
- 原逐轮rebase／暂存／计数变化记录保留在`git show b892ea8f:docs/harness/final-restock-recommendation/handoff-pr3.md`，不作现行Git操作授权。
- 2026-10-24仅整理PR4工作区中的历史文档，没有修改PR1～PR3分支或提交；本轮实际检查与Git状态见PR4交接。
