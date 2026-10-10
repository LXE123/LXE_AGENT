---
name: shangman-products-export
description: 导出上马 ERP 中涉及 Shopee（虾皮）和 TikTok Shop（TK）业务的海外仓商品、库存及销量原始 XLSX。用于上马数据导出和备货数据准备。
type: replenishment
commands:
  - lxeskill shangman products export
---

# 上马商品导出

## 数据内容

上马 ERP 提供涉及 Shopee（虾皮）和 TikTok Shop（TK）业务的海外仓商品数据，商品、库存和销量保存在同一份原始 XLSX 中。

- **商品信息**：SKU、商品名称、仓库名称、创建时间。
- **库存信息**：总数量、有效库存、锁定库存、在途库存、预警库存。
- **销量信息**：7、15、30 天累计销量。

数据来自上马 ERP，字段口径以原表为准。

## 获取命令

```bash
lxeskill shangman products export
```

导出使用桌面「上马」配置和已保存的登录态；登录能力见 `shangman-login`。

命令导出当前配置账号可见的全量原表，返回文件路径、工作表及数据行数。目前不支持按销售平台、店铺、日期或仓库筛选，也不计算备货数量。
