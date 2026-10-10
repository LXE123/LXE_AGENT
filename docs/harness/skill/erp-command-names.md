# ERP 导出与越南计算命令

ERP 导出按数据源组织，统一以 `export` 结尾；计算使用 `calculate`。以下命令都加 `lxeskill` 前缀，仅接受命令行选项，旧命令和别名已删除。结果仍为结构化 JSON。

| 旧命令（不可再调用） | 当前命令 |
|---|---|
| `yacang export run` | `yacang reports export` |
| `shangman export run` | `shangman products export` |
| `mabang-tms export run` | `mabang-tms products export` |
| `mabang brazil-overseas export run` | `mabang brazil reports export` |
| `replenish msku download` | `mabang store msku export` |
| `replenish inventory actual-export` | `mabang store shenzhen-inventory export` |
| `replenish shipments unlinked-download` | `mabang store unlinked-shipments export` |
| `fba msku detail-download` | `mabang delivery msku export` |
| `fba shipment delivery-csv-download` | `mabang delivery export` |
| `fba shipment wms-box-download` | `mabang delivery packing-list export` |
| `fba stock-sku download` | `mabang delivery inventory-sku export` |
| `vietnam stock recommend` | `vietnam replenishment calculate` |

## 参数

- 雅仓：可重复的 `--report inventory-sales|inventory|products` 和 `--warehouse <编码>`；创建日期用 `--created-from`、`--created-to`，必须成对提供。只导出全局产品资料时不能筛选仓库。
- 巴西：可重复的 `--report inventory-sales|pending-transfers-within-3-months|received-transfers-before-3-months`。范围沿用平台快捷筛选，不将它推断为签收日期。
- 越南：必填 `--sales-file`、`--inventory-file`、`--products-file`，可选 `--sku-map-file`。
- SP 发货单号统一使用 `--delivery-no`；已有超时、轮询选项使用 `--timeout-seconds`、`--poll-interval-seconds`。店铺选择、输出目录和装箱拆分规则不变。
- 这 12 个命令不接受 `--params`、`--input-json`、`--stdin-json`。其他业务命令维持自己的输入方式，用 `lxeskill describe <命令>` 查看契约。

## 数据与结果

新报表标识只在 CLI 边界转换，结果中 `report`、`reports` 使用新值。内部任务标识、ERP 请求和原始错误诊断保持原样，文件内容、校验规则及产物目录不变。

Skill 目录采用新命令各段以连字符连接，越南计算使用 `vietnam-replenishment`。应用数据仍保存在 `skill-data/vietnam-stock-recommendation/`，不因 Skill 改名搬迁或重置配置。

AI 通过 `exec` 执行命令，运行中等待同一次任务，检查最终 `ok`、`data`、`error`、`files`，成功后按任务需要使用 `send_files`。权限不足走现有单次审批，拒绝后停止。
