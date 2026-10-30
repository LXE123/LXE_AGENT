# PR3：自动取数与Desktop集成交接

> PR3已确认HEAD为`092b24cc`。独立V2完整Skill和uq122 AG均已由PR4替代；现行执行见[PR4交接](handoff-pr4.md)。本文保留PR3职责、决策与关键证据。

## 范围与依赖

- 分支 `codex/final-restock-auto-data`，pool-7，PR #103；依赖PR2 `af0d7b8b`及PR1 `979c33e8`。
- 店铺名任务复用原店铺解析、MSKU导出、深圳真实库存、三类未关联货件、认证及send_files；PR2生成器消费文件，PR1拥有公式。
- 库存命令可显式接受本轮MSKU路径，复用来源指纹和普通／组合库存算法；文件级失败不能当成合法空库存。
- Desktop通过既有preload→受信任IPC→lxeskill内部设置命令读取／保存旺季配置，不直接读业务存储。

## 历史决策及可追溯提交

| 提交／阶段 | 实际职责与原因 |
|---|---|
| `f3ab2e77`自动取数指引 | 编排复用已有取数Skill，未新建ERP下载模块。原独立V2编排已被PR4统一入口替代。 |
| 库存搜索状态修复 | 原Session延续Cookie和searchToken，拒绝缺Token／HTML错误导出；保留清理、真实异常及脱敏诊断。 |
| `1a464532`会话／耗时 | 在既有官方API上复用单轮目录查询Client，记录库存／组合阶段耗时；并发店铺隔离、配置变化、失败／取消关闭有测试。线上性能收益未验证。 |
| `ee593539`、`f01118f9`设置 | PR3原持久开关及天数UI。后续曾收敛为仅保存天数；当前PR4已接纳页面修复，并按最新需求提供有效开关，历史与当前状态见下节。 |
| `f9ef4801`（PR2）、`af0d7b8b`（PR2） | 35列／14公式／旺季参数与源文本保真分别归位PR2，由祖先关系继承。 |
| `092b24cc`旺季flag修复 | 省略为False、裸flag为True；拒绝内联`=false/=true`或分隔值，执行前返回invalid_arguments。没有重构全局布尔解析系统。 |

旧Skill目录文档由main删除，PR3沿用删除；不恢复重复注册清单。原有MSKU身份再核验、货件API店铺ID解析有独立职责，不等于新增第二轮全量取数。

## Desktop补丁历史与PR4当前状态

- 早期补丁位于`codex/amazon-v2-settings-cleanup`／pool-11，基于092b24cc，原10文件方案复用现有IPC／Service，当时移除无计算作用的开关、仅保存天数。
- 失效开关、公共页头和CSS隔离三处修复，以及设置页命名适配，已进入PR4提交`af8f298f`。该提交复用WorkbenchPageHeader并隔离Amazon／越南样式，不再是等待迁入PR4的独立草稿。
- 此后用户批准调整旺季交互：PR4在af8f298f之后的旺季交互调整中提供实际控制计算的checkbox，页面初始关闭、开启时必填天数、无默认30天，本轮聊天要求优先；旧无版本配置保留天数但按关闭读取。这是后续业务变更，不是恢复早期无效开关。
- pool-11的`docs/record/20261024-amazon-v2-settings-cleanup.md`保留早期补丁及验证来源；当前执行、命令和验证范围见[PR4交接](handoff-pr4.md)。PR3及pool-11原分支、工作区和历史不改。

## 关键历史证据（不累计为本轮执行）

| 对应阶段 | 结果与边界 |
|---|---|
| 库存searchToken／Cookie修复 | 相关七文件244 passed，使用错误fixture和本机模拟HTTP；没有生产请求。 |
| 会话作用域／计时 | 相关回归167 passed，包含去重、分页、作用域隔离、关闭和诊断；不能据此声称线上加速。 |
| PR2源文本修复af0d7b8b继承 | 本checkout90 passed、无skip，含实际Office；Bun42 pass。PR2同源2002行／35列／28028公式／0错误是其离线证据，当时AG仍为uq122。 |
| PR3 `092b24cc` flag修复 | CLI/infra560 passed、4 Windows skipped；工作簿／CLI／A规则／设置114 passed无skip，含Office；Bun42 pass。日志`/private/tmp/pr103-cli-infra-regression.log`。 |
| 2026-10-21 main兼容 | Python424 passed、Bun86 passed、Desktop475 passed/3 skipped；类型检查及Desktop构建通过。这是当时版本，不能证明当前main兼容。 |

测试有重叠，不将各轮数量相加。Office使用既有LXE_OFFICE_NODE/LXE_OFFICE_CLI，独立uv环境不共享；新历史没有新增业务缓存或网络框架。

## 当前限制、Git与下一步

- PR3阶段的34列／13公式、未核验行省略建议、uq122强制取数及独立完整Skill均是历史；当前35列／14公式与深圳AG以PR4为准。
- 当前V2库存未知时保留全部MSKU、AG留空、生成待核对文件且失败，尚未获正式交付批准；V1原规则不受影响。
- 403应立即停止；原store_resolver及相关服务历史恢复逻辑由独立`codex/amazon-network-recovery`处理，未纳入本PR提交，不声称已修复。
- 真实Agent模型行为、当前Desktop完整聊天／生产ERP／外部附件、Windows及Microsoft Excel为NOT VERIFIED；旧版本成功记录不替代当前验收。
- 2026-10-24只在PR4整理历史交接；pool-7现有11项草稿和其他工作区保持原样，不改PR Base或提交历史。
- 完整被压缩原文、原样本SHA及阶段日志路径可用`git show b892ea8f:docs/harness/final-restock-recommendation/handoff-auto-data.md`追溯；本轮实际结果见PR4交接。
