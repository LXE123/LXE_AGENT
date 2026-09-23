# 智汇 TMS 长期 Contract 收敛设计

## 目标与边界

本次只收敛智汇 TMS 菲律宾商品全量导出的 Skill、公开 catalog 参数、Python normalizer、业务 adapter 和 lxeskill terminal result。目标链路固定为：

```text
用户表达 → 唯一 canonical 参数 → preview → 人工确认卡 → execute → files 交付 → 结束
```

不新增平台 pre-filter、特殊 Runtime Tool、`plan_id` 或 Runtime 会话状态；不改变生产 API、登录、账号锁、会话复用、重试、限速、下载和分页实现；不修改雅仓、智慧印尼或马帮的业务代码与 Skill。

## 修改前 Contract

### 输入与默认规则

当前智汇公开命令有两个 action-specific path，但两者都要求四个参数：

```json
{
  "platform": "zhihui_tms",
  "warehouse": "PH",
  "intent": "product_export",
  "fields": ["inventory"]
}
```

`fields` 由 normalizer 进行枚举、非空、去重校验，但不参与底层 API 请求、导出列选择、文件类型选择、成功判断或 workflow 分支。Skill 对未指定国家的表述仍留有“由 AI 判断菲律宾范围”的自由空间。

### 输出与完成判断

`export_products` 把 action、分页限制、内部 artifacts、请求计数等内部执行信息直接作为业务 payload 返回。catalog 再从 `artifacts[].path` 生成顶层 `files`。因此模型同时看到 `data.artifacts` 和 `files`，并需要自行判断 preview 是否在等待确认、合并是否完成以及部分文件能否交付。

通用 Python CLI 目前把整个业务 payload 放进 terminal 的 `data`，失败时统一使用 `business_cli_failed`，无法让智汇以不影响其他业务的方式暴露明确的部分成功错误码。

## 修改后 Canonical Contract

### 唯一输入

preview 与 execute 使用完全相同、无选择空间的输入 schema：

```json
{
  "platform": "zhihui_tms",
  "warehouse": "PH",
  "intent": "product_export"
}
```

三个字段均为 required，分别使用 `const`，并保持 `additionalProperties: false`。`fields` 从 catalog、CLI 参数、normalizer、plan 和测试 fixture 中删除；不会改名为新的执行字段。库存、销量、SKU、入库时间、上架时间只用于模型理解“这是商品数据请求”，不影响下游执行。

当前版本的确定性语言规则为：用户当前轮明确说“智汇”或“TMS”而未指定国家时，固定归一为 `PH`，不追问国家。只说“菲律宾库存”时平台仍不明确，不进入智汇 Skill。当前轮明确的平台优先于历史 Context；雅仓、智慧印尼、马帮巴西请求不由智汇接管。

因为 preview 与 execute 都通过同一个 normalizer，且参数空间固定为三个 const 字段，确认卡后 execute 没有可重新解释原始自然语言的输入。无需引入 `plan_id`；测试将断言两个 catalog schema 和 canonical 参数完全一致。

### preview terminal result

preview 成功时不创建客户端、不读取登录态、不访问网络、不生成文件。terminal result 的业务摘要固定表达“参数已确定、正在等待确认”：

```json
{
  "protocol_version": "1",
  "type": "result",
  "ok": true,
  "data": {
    "platform": "zhihui_tms",
    "country": "PH",
    "business_type": "product_export",
    "confirmation_required": true
  },
  "files": []
}
```

catalog 中 execute 的现有 confirmation 声明继续是唯一业务门禁。它在 execute 实际运行前展示“确认执行导出/取消”卡片；普通聊天文本不能绕过该卡片。

### execute 完整成功 terminal result

业务代码完成分页抓取、下载和 XLSX 合并后，才返回成功。顶层 `files` 只包含 catalog 已校验的最终合并 XLSX，是唯一交付真源；`data` 不包含 artifacts、分页列表、原始平台响应、内部上限或调试信息。

```json
{
  "protocol_version": "1",
  "type": "result",
  "ok": true,
  "data": {
    "platform": "zhihui_tms",
    "country": "PH",
    "business_type": "product_export",
    "row_count": 1234
  },
  "files": ["/validated/artifact/智汇tms-商品-合并-20260922.xlsx"]
}
```

当 `ok=true` 且 `files` 非空时，Skill 明确要求直接交付文件并结束，不重新调用 preview/execute、不搜索 fixture/parser/transcript，也不从 `data` 推断是否完成。

### 部分成功 terminal result

下载或合并失败但现有工作流已产生经过验证的部分 XLSX 时，保留这些文件并使用失败终态。`partial` 是程序给出的结构化事实，不依赖模型从文件名、分页数量或错误字符串推断。

```json
{
  "protocol_version": "1",
  "type": "result",
  "ok": false,
  "data": {
    "platform": "zhihui_tms",
    "country": "PH",
    "business_type": "product_export",
    "partial": true,
    "partial_pages": 2,
    "partial_rows": 2000
  },
  "files": ["/validated/artifact/智汇tms-商品-部分合并-20260922.xlsx"],
  "error": {
    "code": "tms_export_partial",
    "message": "ZhihuiTmsDeliveryError: 第 2 页导出文件下载失败"
  }
}
```

该消息仅展示错误形状；运行时仍由业务 adapter 从实际异常生成并脱敏，不能使用这个示例文案替代真实错误。错误码遵循现有小写业务码风格。没有部分文件的失败使用 `partial: false`，`files: []`，并保留真实、脱敏后的既有业务错误码或回退码，不制造“部分成功”语义。

## 四层同口径

| 层 | 修改后职责 |
| --- | --- |
| `skills/zhihui-tms-product-export/SKILL.md` | 规定智汇/TMS 默认 PH、唯一商品全量导出、preview→确认卡→execute、files 结束条件、部分成功语义和安全停止条件。 |
| `lxeskill/catalog.json` | 公开两个 action path；两者都要求相同的三个 const 字段；execute 保留 confirmation；从 artifact payload 映射最终可交付 files。 |
| `services/zhihui_tms/intent.py` 与 `planner.py` | 只接受三个 canonical 参数；不保存或传播 `fields`；两个 action 共用同一 normalizer。 |
| `services/agent_cli/zhihui/export_products.py` | 保持现有生产工作流，新增紧凑终态投影：preview 等待确认、完整成功、部分成功或失败。内部 artifacts 只供文件校验使用，不进入暴露给模型的 data。 |

## 向后兼容的终态摘要投影

为让智汇的外层 `data` 紧凑且在部分成功时保留明确错误码，Python 的通用 `execute_module_json` / `_finalize_payload` 增加一个**业务自愿提供**的结构投影，不加入任何智汇名称、平台枚举、文件推断或错误判断。

业务 payload 可选输入形状：

```json
{
  "success": false,
  "artifacts": [{"path": "/validated/file.xlsx"}],
  "terminal_projection": {
    "data": {"platform": "zhihui_tms", "partial": true},
    "error": {"code": "tms_export_partial", "message": "实际且已脱敏的失败信息"}
  }
}
```

启用条件和行为如下：

1. 仅当业务 payload 存在 `terminal_projection`，且其 `data` 为 object 时，通用层将它投影为外层 terminal `data`。
2. `files` 始终仍从原始业务 payload 的 catalog `artifact_paths` 收集、路径校验和去重；通用层不查看 artifacts 的业务含义。
3. 失败时只有 `terminal_projection.error` 是完整、非空的 `code` 与 `message` object，通用层才将它投影为外层 `error`；否则保留原有 `business_cli_failed` 与既有消息优先级。
4. 没有 `terminal_projection` 的所有业务 payload 继续把原 payload 作为 data，且保留现有错误码和文件行为，达到向后兼容。
5. 通用层只验证结构，不根据平台、文件数量、`partial` 或异常类型作判断；`partial`、业务码和真实脱敏消息都由智汇 adapter 决定。

这是一处受限的 Python CLI contract 投影，不修改 Bun Agent Runtime、确认卡状态、ToolRegistry 或其他平台业务实现。

## 实施与测试范围

1. 先以失败测试固定：无 `fields` schema、normalizer 拒绝 `fields`、preview 的等待确认终态、完整成功的最小 data + 一个最终 files、部分成功的 `partial=true` + 可交付 files。
2. 修改 catalog、Skill、intent、planner 和 adapter，并让 preview/execute 的三个字段 schema 严格相同。
3. 给通用终态摘要投影增加独立单元测试：缺少投影的旧 payload 输出保持不变；带投影的成功/失败 payload 只改变顶层 data/error，不改变 artifact 收集。
4. 运行智汇 CLI fixture、catalog/contract Python 测试和 Bun catalog 读取测试；增加雅仓、智慧印尼、马帮代表性 terminal fixture 回归，证明未提供投影的结果形状与错误码未变。
5. 不访问生产环境；保留既有 fixture 下载、账号锁、凭据注入、加密 session、401 单次恢复及 403/429/验证码停止测试。

## 明确不做

- 不新增智汇专用自然语言 parser、Runtime pre-filter、特殊 Tool、独立销量/库存/SKU Skill 或 workflow。
- 不新增 `plan_id`、confirmation id 或 Runtime 持久化状态。
- 不改智汇 HTTP 请求、认证、Cookie/Token 处理、会话宿主、重试/退避、分页、下载、XLS/XLSX 校验或文件合并算法。
- 不修改雅仓、智慧印尼、马帮业务逻辑、Skill 或公开 Contract；通用投影仅由主动提供者启用。
- 不进行生产调用、提交或推送。
