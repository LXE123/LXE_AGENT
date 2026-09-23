# 雅仓 AI 结构化意图设计

## 目标

雅仓自然语言导出由 AI 在调用 Skill 时转换为结构化业务参数；Python 代码不再从用户原始话语中提取业务意图，只负责校验、补全确定性默认值、规划和执行。

## 新旧边界

- Skill 的公开输入使用 `data_type_intent`、`warehouse_intent`、`created_date_filter` 和 `inventory_snapshot_intent`。
- `request_text` 暂时保留为兼容输入，但正常结构化调用不得依赖它；新路径禁止调用 `parse_request_text`。
- Python 保留参数合法性校验、仓库固定顺序、默认四仓、默认创建日期、日期范围校验、能力边界和生产门禁。
- AI 负责从用户话语识别数据类型、仓库、创建日期条件和库存快照意图；无法确定时传 `ambiguous`，由业务层返回澄清问题，不发起网络请求。

## 参数契约

```json
{
  "data_type_intent": {"state": "resolved", "values": ["inventory-sales"]},
  "warehouse_intent": {"state": "resolved", "values": ["MY8801"]},
  "created_date_filter": {"state": "resolved", "mode": "relative_days", "days": 30},
  "inventory_snapshot_intent": {"state": "omitted"}
}
```

`created_date_filter` 的 `explicit_range` 由 AI 提供 `start_date` 和 `end_date`，格式为 `YYYY-MM-DD`。代码只验证日期，不从自然语言猜日期。旧 `request_text` 调用保留在内部兼容测试路径，直到迁移完成。

## 安全与兼容

- 任何未知字段、未知枚举值、非法日期或不支持的业务范围都必须失败或返回澄清，不得猜测。
- 结构化参数不改变现有生产门禁、限速、403/429 停止和错误真实性要求。
- 不删除现有底层导出实现；只替换自然语言意图入口。
