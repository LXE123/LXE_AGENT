# L3 command contract deviations

状态：Current

日期：2026-07-14

## 背景

L3 catalog 驱动测试在不修改生产模块和 `catalog.json` 的前提下，对所有 module 型命令检查统一 `run(arguments)` 入口，并根据顶层 `input_schema.required` 自动生成缺参用例。本记录列出取证时发现、但不在本轮顺手修复的现有差异。

## 已知差异

以下 shipment stage 命令缺少 `context_file` 时沿用 workflow envelope，返回 `params_ready=False`、`finished=False` 和 `exception`，而不是其他业务模块常用的 `success=False` 或 `ok=False`：

- `fba shipment confirm-own-carrier`
- `fba shipment enter-tracking-codes`
- `fba shipment prepare-multi-box`
- `fba shipment prepare-upload`

contract runner 只为这四个明确命令断言 `params_ready=False`，没有把全局失败合同放宽为任意 false-like 字段。

以下 module 的实际参数组合比 catalog 顶层 `required` 更严格，因此不会由顶层 required 自动用例完整覆盖：

- `fba msku detail-download`：模块要求 `ship_no` 或 `delivery_no`，catalog 未声明 `required`/`oneOf`。
- `replenish msku download`：模块要求 `store_id`、`id_type` 和 `store_name`，catalog 未声明这些必填关系。

它们的现有显式失败用例继续保留，直到 L3 的 `FAILURE_CASES` 表接管对应文案锚点。是否调整 catalog schema 或统一 workflow envelope 应作为独立接口变更评审，不属于本轮测试去重。
