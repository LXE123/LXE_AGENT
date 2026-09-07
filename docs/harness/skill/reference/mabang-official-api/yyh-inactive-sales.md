# YYH-US 停售 MSKU 的近 7 天销量核查

独立脚本 `scripts/check_yyh_inactive_sales.py` 使用马帮官方 `hwc-get-listing` 的 `pStatus=["Inactive"]` 查询停售商品，再与马帮 MSKU Excel 的 `7天销量` 列精确关联。Listing 接口本身不提供该销量字段。

从仓库根运行：

```bash
uv run --frozen python scripts/check_yyh_inactive_sales.py \
  --env-file /path/to/data-server.env \
  --output-dir /path/to/new-validation-directory
```

默认使用已有浏览器认证服务下载新源表。可用 `--auth-state /path/to/state.json` 显式指定已有 Cookie 快照，凭据只在内存中使用，不复制到输出；也可用 `--source-xlsx /path/to/202609071111-Amazon-YYH-US_店铺MSKU数据.xlsx` 检查指定历史表。后者依然查询当前 Listing，两个数据时间分别记录，不视为同一历史截点。

输出目录必须不存在。脚本写入 `.gitignore`、`summary.json`、`details.csv`、源表副本及脱敏官方响应。发生接口、分页或范围错误时退出非零并保存 `error.json`，不生成成功结论。不会修改正式备货参数，也不会覆盖已有源表或报表。

## 判断规则

限定官方店铺 `sid=2021143528`、站点 `us`，逐页验证店铺、站点和停售状态。按 MSKU＋ASIN 匹配，保留大小写并沿用 SKU 空白规范化。不要求有本地 SKU，也不排除 `Amazon.Found.*`。

空销量、非数值、负数、非整数、缺失关联和重复冲突均为“无法判断”，不能转成零。重复一致的记录合并，不叠加销量。CSV 先列非零销量，再列无法判断，最后列零销量，保存原始销量和源表行号。

有任何确认的非零销量即可回答“不是全部为零”；只有非空停售集合全部确认零销量，才回答“全部为零”。零条停售记录与全部未知都有独立结论。`inactive_unique_count` 按 MSKU＋ASIN 计数，`inactive_unique_msku_count` 单独统计 MSKU 数量。

## 2026-09-07 实测

源表 `202609071111-Amazon-YYH-US_店铺MSKU数据.xlsx` 共 2358 行。随后官方接口返回停售 Listing 991 条、1 页，无重复 MSKU；927 条匹配源表，64 条在源表中找不到。

匹配记录中，896 条近 7 天销量为零，31 条非零，合计 45 件（20 条各 1 件、8 条各 2 件、3 条各 3 件）。因此本轮结论为：**停售 MSKU 并非近 7 天销量全部为零**。这不证明商品何时停售，也不能把 64 条未匹配记录计作零销量。

此前报错的 `Amazon.Found.B0CBMS5WT4` 与 `Amazon.Found.B0CCYC9R71` 本轮均为停售，近 7 天销量均为 0，不能据此推断其他停售商品也没有销量。

本机证据目录：`outputs/yyh-inactive-sales-20260907-check1/`。另以源表 XLSX 内部 XML 独立核对全部 927 条已匹配记录的 MSKU、ASIN 和销量，结果一致。

定向测试：`uv run --frozen pytest python/lxeskill_cli/tests/test_yyh_inactive_sales.py`，覆盖分页、跨店铺/站点、非停售混入、缺失值、重复冲突、无本地 SKU、跨 ASIN、空结果和 CSV 空值保留。
