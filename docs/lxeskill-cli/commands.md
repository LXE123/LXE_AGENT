# lxeskill 命令手册

**lxeskillCLI 是一个集成多个业务模块的命令行程序，通过统一的 `lxeskill` 命令入口提供业务自动化能力。**

**配套 Skill 为 Agent 提供任务知识、工作上下文和命令使用指引。**

**目前业务命令按用途分为 FBA、备货、运营三类。**

下方命令清单与终端帮助使用同一份定义。分组中的命令省略共同前缀 `lxeskill`；例如，发货单下载归入 FBA，执行时仍使用 `lxeskill mabang delivery export`。

- [整体入口](#整体入口)
- [FBA](#fba)
- [备货](#备货)
- [运营](#运营)
- [公共能力与维护](#公共能力与维护)
- [典型调用示例](#典型调用示例)
- [查看具体参数](#查看具体参数)

<!-- BEGIN GENERATED COMMAND REFERENCE -->

## 整体入口

```text
$ lxeskill --help

LXE 业务命令行工具

业务分组：
  help fba            FBA：发货、采购、装箱、货件及相关单据
  help replenishment  备货：库存与销量采集、分析和补货计算
  help operations     运营：Listing、关键词、竞品和评价分析

公共能力：
  help common  浏览器操作与共用认证维护

查询与检查：
  list           查看可用命令及结构化定义
  describe       查询指定命令的结构化定义
  datasets list  查看数据集目录
  doctor         检查命令与 Skill 契约
  cloud-context  查看云端身份与授权范围
  cloud-status   检查云端接入状态

用法：
  lxeskill help <业务分组>      按业务用途查找现有命令
  lxeskill <命令前缀> --help    查看该前缀下的命令
  lxeskill <完整命令> --help    查看参数和示例

帮助为只读查询，无需业务账号；list、describe 仍返回结构化 JSON。
```

## FBA

```text
$ lxeskill help fba

FBA：发货、采购、装箱、货件及相关单据

发票、报关与退税：
  fba customs preview              预览报关资料与缺货情况
  fba customs fill                 使用已确认的预览生成报关资料
  fba export-tax delivery-summary  汇总发货单退税产品
  fba export-tax products-import   维护退税产品白名单
  fba invoice fill                 填写发票模板

发货数据采集：
  mabang delivery msku export           下载发货单 MSKU 明细
  mabang delivery export                下载马帮 FBA 发货单原始 SKU CSV
  mabang delivery packing-list export   下载马帮 WMS 托运单装箱 Excel
  mabang delivery inventory-sku export  按本地发货单 CSV 下载库存 SKU 数据

采购与备货单据：
  fba purchase summary-create    生成采购汇总、备货单和合同
  fba purchase files-regenerate  按已有采购批次重新生成文件
  fba restock workbook-create    生成单 SP 备货单（兼容入口）

货件与装箱：
  fba shipment confirm-own-carrier   确认自选承运人
  fba shipment enter-tracking-codes  填写追踪号
  fba shipment prepare-multi-box     准备多包装箱文件
  fba shipment prepare-upload        准备货件上传
  fba erp packing-upload             预览并确认实际发货量上传到 ERP

以上为现有完整命令路径，执行时加 lxeskill 前缀；不需要再加业务分组名。
使用 lxeskill <完整命令> --help 查看参数和示例。
```

## 备货

```text
$ lxeskill help replenishment

备货：库存与销量采集、分析和补货计算

东南亚及巴西备货：
  feishu stock-lists sync          同步飞书备货清单
  mabang brazil reports export     导出马帮巴西海外仓报表
  mabang-tms products export       导出马帮 TMS 商品、库存和销量
  yacang reports export            导出雅仓报表
  vietnam replenishment calculate  计算越南补货并生成备货清单
  shangman products export         导出上马商品、库存和销量

上马数据采集的登录准备：
  shangman login prepare  准备登录并获取验证码
  shangman login submit   提交验证码
  shangman login status   查询登录状态
  shangman login clear    清除登录状态

Amazon 备货：
  replenish template                          管理备货算法参数方案
  replenish inventory restock-snapshot-build  解析亚马逊补充库存 CSV
  replenish calculate                         计算备货建议
  mabang store msku export                    下载店铺 MSKU 数据
  mabang store shenzhen-inventory export      生成深圳仓真实库存报告
  replenish sales analyze                     分析销量
  replenish store resolve                     解析马帮店铺名称与 ID
  mabang store unlinked-shipments export      下载未关联货件并生成快照

以上为现有完整命令路径，执行时加 lxeskill 前缀；不需要再加业务分组名。
使用 lxeskill <完整命令> --help 查看参数和示例。
```

## 运营

```text
$ lxeskill help operations

运营：Listing、关键词、竞品和评价分析

Amazon 运营：
  amazon listing analyze       分析 Listing
  amazon reviews analyze       分析商品评价
  amazon keywords research     研究关键词
  amazon competitors research  查找与分析竞品

以上为现有完整命令路径，执行时加 lxeskill 前缀；不需要再加业务分组名。
使用 lxeskill <完整命令> --help 查看参数和示例。
```

## 公共能力与维护

```text
$ lxeskill help common

公共能力与维护：浏览器操作与共用认证维护

浏览器操作：
  browser store  管理紫鸟店铺浏览器
  browser page   读取或操作紫鸟浏览器页面

马帮认证维护：
  mabang auth refresh         强制刷新已配置账号的马帮 ERP 登录态
  mabang auth browser bind    绑定独立 CLI 的认证浏览器
  mabang auth browser status  查询认证浏览器绑定状态
  mabang auth browser unbind  移除认证浏览器绑定

以上为现有完整命令路径，执行时加 lxeskill 前缀；不需要再加业务分组名。
使用 lxeskill <完整命令> --help 查看参数和示例。
```

## 典型调用示例

执行前将尖括号内容替换为实际值，单号等示例值也应按任务修改。

### 下载马帮 FBA 发货单原始 SKU CSV

```bash
lxeskill mabang delivery export --delivery-no SP260919007
```

### 管理备货算法参数方案

```bash
lxeskill replenish template list
```

### 计算备货建议

```bash
lxeskill replenish calculate --store-name <店铺名>
```

### 分析 Listing

```bash
lxeskill amazon listing analyze --asin <ASIN>
```

<!-- END GENERATED COMMAND REFERENCE -->

## 查看具体参数

```bash
# 按命令前缀逐层查找
lxeskill mabang --help
lxeskill mabang delivery --help

# 查看完整命令的参数、必填项、已声明的默认值、可选值和示例
lxeskill mabang delivery export --help

# 程序需要结构化定义时使用
lxeskill describe mabang delivery export
```

`lxeskill help fba` 按业务用途列出全部 FBA 命令，包括 `mabang delivery …`；`lxeskill fba --help` 只查看 `fba` 这个命令前缀下的下一层。业务分组不是额外的命令前缀。

帮助输出只读文本，不执行业务、不联网，不初始化业务目录或日志，也不要求配置业务账号。`list`、`describe`、`datasets list` 返回结构化 JSON，业务命令的结果同样通过 stdout 返回 JSON，诊断输出到 stderr。

`internal` 集成命令默认不出现在清单中，知道完整命令的调用方仍可查询其帮助；隐藏不代表执行权限限制。业务调用需要相应账号和文件写入权限；日志容错与诊断规则见 [日志与诊断](../logging.md)。

## 维护这份手册

命令名称、参数、分组、用途和示例维护在 [Catalog](../../python/lxeskill_cli/lxeskill/catalog.json)，终端帮助与本文清单共用 [帮助实现](../../python/lxeskill_cli/lxeskill/help.py)。新增或修改命令后，在仓库根运行以下命令，将生成的手册变更一起提交：

```bash
uv run --frozen python scripts/generate-lxeskill-command-docs.py
```

生成脚本只更新标记区域。Skill 负责介绍任务知识和工作流程，具体命令用法在这里查阅。
