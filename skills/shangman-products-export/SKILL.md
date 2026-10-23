---
name: shangman-products-export
description: 导出上马 ERP 中涉及 Shopee（虾皮）和 TikTok Shop（TK）业务的海外仓商品、库存及销量 XLSX，按 ERP status=2 启用商品范围筛选并保留官方原始业务字段及数值。用于上马数据导出和备货数据准备。
type: replenishment
commands:
  - lxeskill shangman products export
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 上马商品导出

## 数据内容

上马 ERP 提供涉及 Shopee（虾皮）和 TikTok Shop（TK）业务的海外仓商品数据，商品、库存和销量保存在同一份官方完整 XLSX 中。这里的“完整”描述数据来源；命令最终交付的是按启用状态筛选后的工作簿，保留官方表格的业务字段及原始值。

- **商品信息**：SKU、商品名称、仓库名称、创建时间。
- **库存信息**：总数量、有效库存、锁定库存、在途库存、预警库存。
- **销量信息**：7、15、30 天累计销量。

数据来自上马 ERP，字段口径以原表为准。

## 获取命令

```bash
lxeskill shangman products export
```

导出使用桌面「上马」配置和已保存的登录态；登录能力见 `shangman-login`。

命令下载当前配置账号可见的官方完整工作簿，并只保留上马 ERP 商品启用状态为 `status=2` 的商品行。该状态不直接表示商品正在平台销售、有销量或必须备货；除此状态筛选外不增加商品筛选条件。商品编码和创建时间按原始文本精确匹配，不随意归一化或截断；无法完整、唯一匹配时整次导出失败。库存、销量及其他单元格仍采用官方工作簿原值。命令返回筛选后文件路径、工作表及数据行数，不计算备货数量。

## 内部接口与筛选流程

导出命令由现有 Service 使用已保存的上马登录态依次调用以下接口；Agent 应通过上面的 Skill 命令触发，不直接调用 ERP 接口：

1. `POST /api/blade-goods/goods/merchant/exportNew`：请求上马生成官方完整 XLSX，响应提供文件下载地址。此接口当前不负责按启用状态筛选。
2. `GET /api/blade-goods/goods/merchant/list`：分页获取商品列表，查询参数为 `status=2`、`current=<页码>`、`size=500`。此处的 `status=2` 表示上马 ERP 商品启用状态，用来确定启用商品范围；分页响应需包含 `current`、`pages`、`total`、`records`，列表记录需有商品 ID、`status`、`goodsNo`、`goodsSku` 和 `createTime` 供校验及关联。

Service 校验列表中的 `goodsNo` 与 `goodsSku` 一致后，使用商品编码和创建时间的原始文本精确匹配，将启用商品逐条关联到官方 XLSX 的对应行，再交付筛选后的工作簿；不对编码或时间做归一化、空白删除或精度截断。列表只决定保留哪些商品行，不用于替换官方表格中的库存、销量或其他业务字段。分页不完整、返回状态异常、身份字段不一致或工作簿行无法一对一匹配时，整次导出失败且不交付文件。
