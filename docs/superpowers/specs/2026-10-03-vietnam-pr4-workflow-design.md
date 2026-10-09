# 越南备货 PR4：确定性 Workflow、CLI 与 Skill 接线

## 基线与目标

从个人仓库 `codex/vietnam-stock-pr3-workbook` 的 `a8dd62aa325c5e09fb590f4c3283fb905519b6d4` 开始；该 SHA 已与远端核对。PR4 将来以 PR3 分支为 base，开发分支为 `codex/vietnam-stock-pr4-workflow`。

业务人员说“生成越南备货清单”时，Agent 通过 `vietnam-stock-recommendation` Skill 调用一个无参数的 CLI。命令按固定顺序检查运营映射表、导出本轮雅仓数据、调用 PR3 五表生成器，并仅将验证通过的最终 XLSX 作为附件候选。此 PR 不实现 Desktop 上传、长期设置或聊天临时四参数。

## 方案选择

采用 Python 单一工作流服务加薄 CLI 适配层。它复用 PR2 的 `export_vietnam_sources()` 和 PR3 的 `generate_vietnam_workbook()`，把调用顺序、输入来源和交付边界放在确定性代码里。让 Skill 分步调用多个 CLI 会把文件选择与失败恢复交给模型；在 Bun Runtime 重组导出与生成会扩大跨语言契约。这两种方案均不采用。

## 工作流契约

新增 `services/vietnam_replenishment/workflow.py`，提供一个不接受映射表路径和模板路径的业务入口。CLI 适配层 `services/agent_cli/vietnam_replenishment/generate.py` 提供 `run(arguments)`；它拒绝非空参数对象，包括通过 `--stdin-json` 或 `--input-json` 传入的额外键。公开命令拟为 `lxeskill vietnam stock recommend`，无四参数选项。

执行顺序固定：

1. 调用 `current_asset("vietnam_sku_parameter_map")`。没有 current 时返回明确的上传指引，立即结束，不调用雅仓。
2. 将选中的 current 文件复制到本次运行的私有临时目录，对快照调用现有 `load_sku_parameters()`。无效、空白或无法读取的映射表在导出前失败，保留实际且必要脱敏的错误。导出过程中即使 current 被替换，本轮仍只用已验证的快照。临时快照在结束时删除。
3. 调用 PR2 `export_vietnam_sources()` 一次；它固定导出 VN8806 库存动销、VN8806 当前库存列表和全局仓库产品，不增加创建日期筛选。任何部分失败、缺表或空 SKU 均停止，不用历史文件补齐，也不自行重试生产调用。
4. 在 catalog 注册 `vietnam_recommendations` dataset，将新成品路径放在受管 artifact root 下，避免覆盖已有文件。以 PR3 默认 `RecommendationConfig()` 调用 `generate_vietnam_workbook(snapshot, output, sources=...)`。PR3 继续负责精确 SKU、商品创建时间、当前库存在途、五表、LibreOffice 重算和结果校验。
5. 仅在成功且文件存在时，返回 `success=true`、最终 `output_xlsx`、本轮 SKU 数等非敏感摘要。任何失败返回 `success=false` 和真实诊断，交付文件集合为空。原始雅仓 XLSX、映射表快照和中间工作簿都不列为 deliverable。

`vietnam_replenishment_template/current`、PR2 的历史模板辅助入口以及旧结果均不参与运行。成本、跨境价、折扣价只来自快照中对应 SKU 的显式值；热销缺失默认 2。仓库产品的 `创建时间` 是本业务已确认的真实上架时间；总在途只取当前库存列表 `在途数量`。这些规则由 PR3 校验，不在 PR4 复制一套计算逻辑。

## CLI 与 Skill

在 `catalog.json` 注册业务命令，`owner_skills=["vietnam-stock-recommendation"]`，公开 schema 为空对象，不使用可被显式路径覆盖的 `x-lxe-asset-slot`。`artifact_paths` 只声明 `output_xlsx` 为 deliverable，失败时不交付；同步扩展 `lxeskill/business.py` 的模块命名校验并登记 dataset。修正 catalog 中旧模板“运行时必须绑定”和映射表“可选”的过期说明。

新 Skill 的描述明确命中“生成越南备货清单 / 根据越南库存销量算补货”。它只调用一次新命令，只读 terminal result 的 `ok`、`data`、`files`；成功且 `files` 恰好一份最终 XLSX 时调用一次 `send_files`。发送失败只重试发送，不重跑导出。没有 current 时提示先上传 SKU 映射表；其他失败报告真实诊断，不发送原始雅仓文件。若用户明确要求本次采用非默认四参数，说明该入口暂未支持覆盖，不默默忽略。东南亚流程入口把越南备货生成路由到新 Skill；独立雅仓原始导出仍使用 `yacang-export`。

## 验证

所有运行用合成映射表和合成雅仓来源，测试中替换导出函数，不调用生产雅仓。定向覆盖：缺 current、损坏或空映射表均零雅仓调用；快照避免 current 中途替换；一次导出三源；雅仓部分失败、缺 SKU 字段、生成及 Office 失败均无最终 deliverable；成功时只有最终 XLSX。至少一条合成端到端用例走真实 PR3 生成器和项目 Office Kit，核对五表、创建时间与在途。运行 `lxeskill doctor`、Python CLI/资产定向测试和 Bun catalog/Skill 定向测试；随后检查 `git diff --check`、状态、敏感信息和无关改动。开发阶段不重复全量测试。

## PR 边界和交接

PR4 仅改 Workflow/CLI/Skill 及必要契约、路由、定向测试和 `handoff-pr4.md`。PR5 再做 Desktop 映射表上传、安全替换与四参数长期设置；聊天临时参数需先确定独立契约，PR4 不提前开放。PR4 完成后按仓库规范逐步提出 commit、push、创建 PR；每项 Git 状态修改分别确认。PR4 收口后记录分支、调用链、修改文件、环境变量、测试结果、风险、依赖与 Git 状态，并在新任务窗口继续 PR5。

## 已知约束

`current_asset()` 只发现 current 目录的文件，本身没有持久校验标记。PR4 每次执行都对私有快照做内容校验；PR5 的 Desktop 上传负责候选文件校验及安全替换，形成可信的 current。PR4 的 CLI 已可正确拒绝缺失 current，但在 PR5 上线前，普通业务人员尚无前端上传入口。
