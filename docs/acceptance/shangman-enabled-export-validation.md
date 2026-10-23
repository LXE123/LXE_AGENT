# 上马启用商品导出验收

本文保留 [PR #94](https://github.com/LXE123/LXE_AGENT/pull/94) 的验证证据。样本与 HTTP 504 记录来自[作者原始交接](https://github.com/LXE123/LXE_AGENT/blob/4f012372e57135dd7df3cabf66bb1a84a49ce7bc/docs/record/20261016-shangman-enabled-export-handoff.md)，最终源码验证见[维护者合并前评论](https://github.com/LXE123/LXE_AGENT/pull/94#issuecomment-6297988863)。本次整理未重新读取业务样本或访问生产 ERP。

当前操作和接口流程由[上马导出 Skill](../../skills/shangman-products-export/SKILL.md)维护：`lxeskill shangman products export` 下载官方 XLSX，再按 `status=2` 列表中的商品编码和创建时间精确匹配保留行。列表只确定范围，不替换官方库存、销量或其他业务字段；启用状态不代表平台在售、有销量或必须备货。

## 最终源码验证

最终提交 `a0d5cdfc` 合入 `main@5b6fa0bb`，合并提交为 `4f012372`。维护者在该提交运行 `bun run verify:source`，退出码 0：协议、生产边界、全部 8 个工作区 TypeScript 检查通过；Bun 2214 通过、10 跳过，Python 2428 通过、6 跳过，均无失败。环境启用 LibreOffice Kit 0.1.5；跳过项不计作通过，未调用生产上马 ERP。

## 样本与失败证据

| 验证 | 结果与边界 |
| --- | --- |
| XLSX 范围修复 | 作者修复后运行 `test_goods_export.py`，65 通过、无失败或跳过。新增 8 个用例覆盖普通/标准只读模式、12/36 列及空结果；修复前其中 4 个只读用例失败，输出读取不依赖 `reset_dimensions()` |
| 真实样本离线重放 | 源表 17,146 行，保留 13,852 行、排除 3,294 行；36 列值、类型、样式差异为 0 行，7/15/30 天销量及库存保持原值。普通与标准只读读取均通过，dimension 为 `A1:AJ13853`，其他 ZIP 成员不变。数量仅对应该样本 |
| 生产尝试 | 自然语言经既有 Skill 与 CLI 请求 `merchant/exportNew`，服务端返回 HTTP 504；CLI 报 `export_http_failed`、退出码 4、`files=[]`。未重试、刷新登录或交付历史文件；下载、列表分页至最终文件的生产端到端未完成 |

后续复验入口：[上马导出测试](../../python/lxeskill_cli/tests/shangman/test_goods_export.py)。历史定向测试与最终全量存在重叠，不相加为新的测试总数。

## 限制与未验收事项

- 两个接口没有已证实的同一快照保证；商品身份冲突、分页不完整或状态异常时停止交付，不放宽编码和时间匹配。
- 公式、合并单元格和多个商品数据工作表仍有拒绝边界，不承诺任意复杂 XLSX 兼容。
- Excel/WPS GUI、完整生产导出，以及真实订单销量准确性未由上述证据证明。HTTP 504 本身不能证明本地筛选实现有缺陷。
