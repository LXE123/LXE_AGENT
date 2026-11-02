# Amazon V2 备货

V1 和 V2 由 `replenishment-workflow-map` 统一编排，分别计算和交付。V1 使用原销量分析、筛选、算法及多 Sheet 模板；V2 保留全部 MSKU，生成 35 列的 `mskulist` 工作表。

## 数据与命令

两版复用同轮合格的 MSKU 源表、深圳真实库存报告和三类未关联货件快照。V2 生成阶段离线读取这三份文件，不重新取数。V1 的计算结果已经过滤过行，不能充当 V2 的原始输入。

- `lxeskill replenish v2 generate`：公开生成命令，接受店铺名及三份文件路径；参数详情通过 `lxeskill describe replenish v2 generate` 查询。
- `lxeskill replenish v2 settings`：供 Desktop 调用的 internal 命令，读写旺季设置。
- 产物使用 `replenish_v2` dataset，目录为当前产物根下的 `replenish/v2/`；目录根由 lxeskillCLI 管理，可通过 `lxeskill datasets list` 查询。

来源校验复用原有来源指纹、店铺、批次、MSKU 身份和覆盖检查。这些业务校验用于防止错店、错批次或漏数据。

## 计算与交付

`replenishment_v2_formulas` 生成 I/J/R/S/U/V/W/X/Y/Z/AA/AB/AC/AI 共 14 个公式，`replenishment_v2_workbook` 负责映射、写表和调用 Office Kit 重算。公式由 Office 执行，不维护第二套 Python 数值算法。

- AG 取深圳报告的“真实库存（深圳仓库）数量”，普通及组合商品沿用报告计算结果；保留正数、真实 0 和有限负数。
- AH 使用报告非空本地 SKU，否则回退同源 MSKU；AD 为单件重量（克），空白按 0，非法非空值报错；AI 为含建议补货的可供天数。
- U 按已确认顺序判断急发空运、空运、海运及组合运输；AA 在 V 或 W 为空时留空，AC 在 AB 或 AD 为空时留空。空海运公式不额外扣减 AG。
- 只在设计列写入公式，源字符串按文本保存。重算后检查工作簿结构、公式及计算错误，通过后才发布正式文件；失败不覆盖已有合格产物。
- 库存未知时 AG 留空，保留全部行及公式，输出“库存待核对”文件并返回失败，暂停 V2 正式交付。这项交付限制仍待运营确认。
- 两版各自判断成功和附件；单方失败不覆盖另一版结果。诊断附件不能当作正式成功产物。

## 旺季设置

V2 尚未发布，按首次发布设计：配置只存一份 `skill-data/amazon-replenishment-v2/parameters.json`，由 lxeskillCLI 在自己的数据目录下管理，内容为 `peak_boost_enabled` 和 `peak_boost_days`。

初次使用关闭，天数为空；开启时必须提供 0～120 的整数天数。公式辅助函数同样默认关闭，开启缺天数会报错。

本轮明确关闭时不加成；本轮开启或单独指定天数时启用，天数优先取本轮值，否则使用保存值；本轮未指定时沿用页面设置。聊天覆盖只作用于本轮，运行使用启动时读取的设置快照。备注规则及 120 天上限继续生效。

读写共用进程间锁。保存先校验，再写同目录临时文件、flush/fsync，最后原子替换。配置损坏和 I/O 失败报告实际错误。开发期间的中间格式、目录、版本标记和双文件恢复方案不构成迁移契约。

## 验证

从仓库根目录使用本 checkout 独立的 uv 环境执行：

```sh
uv run --frozen pytest python/lxeskill_cli/tests/mabang/test_replenishment_v2_formulas.py python/lxeskill_cli/tests/mabang/test_replenishment_v2_settings.py python/lxeskill_cli/tests/mabang/test_replenishment_v2_workbook.py python/lxeskill_cli/tests/mabang/test_replenishment_v2_shenzhen_delivery.py python/lxeskill_cli/tests/mabang/test_replenishment_versions.py python/lxeskill_cli/tests/lxeskill/test_replenishment_v2_settings_cli.py
```

公式测试需要 LibreOffice，完整工作簿测试还需要当前 checkout 的 Office Kit 运行时。缺失导致的跳过不能算作重算通过。测试应检查实际返回值、CLI 终态、文件状态和重算数值，不通过扫描源码或复述公式文本证明业务正确。

具体提交的验证结果记录在 PR。离线测试与 Office 重算不代表真实模型选路、生产 ERP、完整桌面聊天、外部附件发送、原生 Windows 或 Microsoft Excel 已验收。

## 本轮交接（2026-11-02）

- PR #117 工作区 `codex/amazon-replenishment-unification`，本轮基于 `11b1094d`。`official_api.py` 对已收到 403/429 后读取正文失败的请求停止重试，保留状态与实际异常；`test_sku_catalog_session.py` 补充该调用链及已结束会话的回归。
- 从仓库根目录用当前 checkout 的 uv 环境运行网络、认证和会话测试 119 项通过；使用本地 Office Kit 的取数及双版本测试 40 项通过。会话测试移除状态判断的内存故障注入按预期失败。
- 使用 `LXE_OFFICE_NODE`、`LXE_OFFICE_CLI` 指向本地桌面运行时；本机 HTTP 测试只使用回环地址。生产 ERP 和真实文件发送未验证，后续由维护者审查。
