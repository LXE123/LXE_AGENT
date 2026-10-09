---
name: vietnam-stock-recommendation
description: 生成越南备货清单。用户说“生成越南备货清单”、要求根据越南雅仓库存和销量计算备货或补货建议时使用；读取当前 SKU 参数映射表，获取同轮 VN8806 数据并交付最终五表 XLSX。只要求导出雅仓原始报表时使用 yacang-export。
type: replenishment
commands:
  - lxeskill vietnam stock recommend
---

# 越南备货清单

## 入口边界

- 这是越南 VN8806 备货清单的完整生成入口。命令会先校验 `vietnam_sku_parameter_map` 的 current，再获取同一轮雅仓库存动销、当前库存列表和全局仓库产品资料，最后生成并校验五表 XLSX。没有 current 时命令会在调用雅仓前停止。
- 运营只需在 Desktop“工作台 → 模板与数据源 → 越南 SKU 参数表”上传一张 `.xlsx` 映射表；五表骨架已随应用内置。不得传用户上传的任意路径、旧版映射表或历史模板，也不得从历史文件猜成本、跨境价或折扣价。
- 当前映射表须存在、有效且至少含一个 SKU，但可以没有本轮雅仓的某些 SKU 行；已有行的成本、跨境价、折扣价也可分别为空。生成成功时，本轮雅仓 SKU 仍全部进入最终五表工作簿的主表与三张雅仓来源表：缺映射行的热销、成本、价格、备货天数、备货量和财务结果留空；已有行的空热销默认 `2`，空价格只让依赖它的财务结果留空。显式 `0` 不视作空白。不要因这些允许的空值拒绝交付，也不要猜测缺失 SKU 的数量或价格。
- 本业务已确认仓库产品的“创建时间”是真实上架时间；总在途取本轮当前库存列表的“在途数量”。这些口径由命令校验和写入，不手工替换来源。
- 本次生成使用 Desktop 保存的长期四参数；运行环境中四项均缺席时才使用系统默认值 `0.8 / 0.8 / 0 / 3900`。命令结果中的 `data.config` 给出本轮生效值，`data.config_source` 只标记可观测来源 `environment` 或 `default`，不得把任意环境注入值称为已保存的 Desktop 设置。若用户明确指定本次使用其他值，先说明聊天临时覆盖暂未支持，并停止本次生成；不要默默忽略要求后按长期值或默认值运行。
- 用户只要雅仓原始报表时转 `yacang-export`，不要启动备货生成。不要用该导出 Skill 的原始文件代替最终备货清单。

## 执行

通过 `exec` 只调用一次以下无参数命令；不直接运行 Python 业务模块，不添加 `--params`、`--input-json` 或映射表路径：

```text
lxeskill vietnam stock recommend
```

命令仍在运行时等待同一次执行，不另起新命令。只读取最后一条 `type="result"` 的 terminal，先看 `ok`，再看 `data.success`、`data.output_xlsx`、`data.error` 和 `files`。

## 结果与交付

- `ok=false` 或 `data.success=false` 时不发送文件。若 `data.error.code=sku_parameter_map_required`，明确提示先在上述 Desktop 入口上传越南 SKU 参数映射表；无有效 SKU、坏表、非法数值、雅仓必要来源缺失或重算失败等其他失败，转述 `data.error.message` 或 terminal `error.message` 的实际脱敏诊断。不调用雅仓补救，不自动重试整轮，也不改用旧文件或历史模板。
- 仅当 `ok=true`、`data.success=true`、`data.output_xlsx` 存在，且 terminal `files` 恰好包含该最终 XLSX 时，调用一次 `send_files(paths=<terminal.files>)`。文件集合不符合条件时停止并报告结果契约异常；不猜文件路径，不发送雅仓原始报表、映射表快照或中间工作簿。
- 附件发送成功后再说已交付，可简要说明本轮 SKU 数和 `data.config` 的生效值及 `data.config_source` 来源。本轮 SKU 数是雅仓 SKU 总数；terminal 没有缺映射 SKU 计数时，不推断或声称具体缺失数量。若 `send_files` 失败，只用同一份 terminal `files` 重试附件发送，不重新运行生成命令。
