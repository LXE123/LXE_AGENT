---
name: southeast-asia-replenishment-workflow-map
description: 介绍东南亚备货的能力、阶段关系，并在需求范围不明确时导航。未指定 ERP 的菲律宾数据使用 philippines-reports-export，交付雅仓与 TMS 合并报表；指定 ERP 时使用对应导出 Skill。越南备货使用 vietnam-replenishment。
type: replenishment
---

# 东南亚备货能力导航

## 当前能力

| 需求 | Skill | 支持范围与产出 |
|---|---|---|
| 越南备货 | `vietnam-replenishment` | 使用雅仓报表和完整九表业务模板，按 SKU 从模板提取参数并完成计算、校验，交付九表备货清单 |
| 菲律宾库存动销与库存列表 | `philippines-reports-export` | 雅仓 PH8805 两份报表加马帮 TMS PH1，按 SKU 相加对应字段；一次交付两份 XLSX，各含雅仓原表和合并结果 |
| 雅仓数据导出 | `yacang-reports-export` | 库存动销、当前库存及全局产品资料；可独立交付，也可提供越南计算输入 |
| 上马 ERP 数据导出 | `shangman-products-export` | 当前账号可见的商品、库存和销量原始 XLSX；后续备货计算尚未接通 |
| 马帮 TMS 数据导出 | `mabang-tms-products-export` | 菲律宾 PH1、越南 VN1 或明确选择的当前账号全部仓库；原字段与同仓 SKU 汇总在同一张表，全部仓库按实际仓库分别交付文件；未指定仓库先询问，后续备货计算尚未接通 |

数据范围由用户要求、账号和对应 Skill 决定，不推断平台固定对应某个国家。巴西数据另见独立的 `mabang-brazil-reports-export`，不属于东南亚能力，也不连接越南计算。

## 技能选择

- 用户要求“导出菲律宾库存动销”或“导出菲律宾仓数据”且未指定 ERP 时，读取 `philippines-reports-export`，自动取得雅仓 PH8805 与马帮 TMS PH1 数据并交付完整两文件结果。指定雅仓或马帮 TMS、创建日期筛选或多仓时，按指定范围使用对应导出 Skill。
- 明确要计算或生成越南备货清单，直接读取 `vietnam-replenishment`。查询已有结果或解释参数也由该 Skill 说明，不能把查询当作重新生成。
- 除上述菲律宾合并流程外，明确要导出某个 ERP 的数据时读取对应导出 Skill；登录衔接由该 Skill 说明。
- ERP 来源优先于国家名称。雅仓菲律宾为 PH8805、越南为 VN8806；马帮 TMS 菲律宾为 PH1、越南为 VN1。国家相同不互相替代，马帮 ERP 与 TMS 也不混用。
- 普通越南仓库数据请求没有已确认来源时，先询问雅仓还是马帮 TMS。已明确来源后使用对应 Skill 的仓库与报表规则，不改变雅仓单仓、多仓、默认四仓和全局产品资料能力。
- 只问整体流程或支持范围时，依据本 Map 解释，不执行业务命令。
- 要准备东南亚数据但来源不明确时，先确认上马、雅仓、马帮 TMS 或所需组合，不默认导出所有平台。要计算其他地区的备货时，说明当前仅支持相应数据采集，不把原始报表当作备货建议。
- 只说“备货”且上下文无法判断业务模块时，先确认 Amazon 还是东南亚，不凭国家名称推断。Amazon 流程使用 `amazon-replenishment`。

越南仓独立导出的来源不明时，桌面复用已有 `ask_user_question` 单选；该轮只提问，等待明确选择后按对应 Skill 执行。非桌面渠道普通提问等待回复。来源已确定但 TMS 仓库不明时，使用 TMS Skill 的 PH1、VN1、全部仓库问题。

```json
{"questions":[{"id":"erp","question":"请选择数据来源","multi_select":false,"options":[{"label":"雅仓"},{"label":"马帮 TMS"}]}]}
```

## 阶段关系

- **完整越南任务**：雅仓取数 → 越南独立计算与校验 → 交付最终清单。是否需要取数、如何复用指定文件或同一任务的产物，由 `vietnam-replenishment` 判断；导出和计算是可分别调用的步骤。
- **菲律宾库存动销与库存列表**：雅仓 PH8805 取数 → TMS PH1 取数 → 本地校验与按 SKU 合并 → 交付两份报表。具体字段对应和来源口径由 `philippines-reports-export` 说明。
- **独立导出或数据准备**：所选 ERP 取数与校验 → 交付报表。除上述已定义流程外，其他东南亚来源目前到此为止，不套用 Amazon 或越南算法，也不自行跨来源合并。
- 阶段之间使用命令返回的真实文件路径和来源信息。失败时保留已完成阶段及实际错误，按对应 Skill 处理；已经完成的执行和交付不重复。

命令参数、认证、筛选、输入校验和失败恢复规则由各业务 Skill 维护。
