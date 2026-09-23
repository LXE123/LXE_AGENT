---
name: zhihui-tms-product-export
description: 用户当前轮明确提到“智汇”或“TMS”，且要求查询或导出销量、库存、入库、上架或商品数据时使用；这些语义都归入菲律宾商品全量导出。当前轮平台优先于历史 Context；不抢雅仓、上马印尼或马帮巴西请求，只说“菲律宾库存”时先澄清。
type: replenishment
commands:
  - lxeskill tms philippines products-export preview
  - lxeskill tms philippines products-export execute
---

# 智汇 TMS 菲律宾商品导出

当前轮明确的平台、数据类型和国家高于历史 Context，不得被上一轮雅仓、上马或马帮参数覆盖。只有用户明确说“刚才”“同上”“还是那个”时才继承缺失参数；当前轮指向其他平台时不进入智汇导出流程。

## 自然语言触发边界

用户请求必须明确指向“智汇”或“TMS”，并命中商品数据意图，才可归一到本 Skill。当前版本只支持菲律宾：用户明确提到“智汇”或“TMS”但未指定国家时，固定归一为 PH，不追问国家；仅说“菲律宾”不足以确定平台。商品、SKU、销量、库存、入库时间、上架时间都只表示同一个菲律宾商品全量导出意图，不代表独立报表或执行分支。以下表达属于本 Skill：

- “导出/下载/拉取/整理智汇菲律宾商品”“把智汇菲律宾商品清单导成 Excel/XLSX”；
- “查智汇菲律宾商品 SKU、销量、库存、入库时间、上架时间，并导出文件”；
- “帮我把智汇菲律宾站的商品数据拉下来”“查询智汇菲律宾库存”“生成智汇菲律宾商品表”；
- “导出智汇商品”“下载智汇商品资料”“导出智汇商品 Excel/XLSX”；
- “查 TMS 库存”“下载 TMS 销量”“导出 TMS SKU”。

只说“菲律宾库存”“导出商品表”或依赖上一轮上下文的简短追问，应先澄清目标平台，不要直接触发本 Skill。请求同时出现雅仓、上马印尼或马帮巴西仓时，留在普通 Agent 路由中分别判断或追问，不能让智汇导出流程直接接管。

本 Skill 不处理订单、物流、发货、采购、财务报表或独立的历史销量/库存报表；先说明当前接口只提供商品全量导出。

模型选中本 Skill 后，只生成唯一 canonical 参数，运行时代码会再次校验平台、仓库和意图。正常导出请求直接调用 `execute`，不调用 `preview`，不等待人工确认，成功后直接交付文件。只有用户明确要求预览执行计划时才调用 `preview`；预览只说明参数已确定，不会登录、访问网络或生成文件。参数不完整或无法确定意图时，不调用本 Skill，回到普通对话。只调用声明的命令，不自己拼 TMS HTTP 请求、Cookie、Token 或账号密码。

```text
lxeskill tms philippines products-export preview --platform zhihui_tms --warehouse PH --intent product_export
lxeskill tms philippines products-export execute --platform zhihui_tms --warehouse PH --intent product_export
```

CLI 不接受凭据参数。执行需要 Desktop 在进程环境中安全注入账号、密码和生产调用开关；缺失时直接返回失败。不要把账号密码写进命令、输入 JSON、聊天或文件。

preview 永远不读取网络或登录态，也不生成文件。preview 成功时 `ok=true`、`data.preview=true` 且 `files=[]`，表示参数预览完成，不是最终导出完成；不要重新分析参数、搜索 fixture/parser/transcript 或再次调用 preview。Desktop 启动的 execute 会优先复用当前账号的加密本机会话；没有有效会话时才登录，Desktop 重启后仍可复用。明确 HTTP 401 或 302 时会清除旧会话、登录一次并仅重放被拒绝请求一次；403、429、下载/网络错误、未知业务错误或第二次认证失败都必须停止，不得再次执行命令。直接运行没有 Desktop 会话宿主的 CLI 时保留一次 execute 一次登录的兼容行为。

所有商品数据表达均归一为 `platform=zhihui_tms`、`warehouse=PH`、`intent=product_export`。没有真实历史接口时，只说明最终导出文件实际提供的内容，不得宣称存在独立历史销量、库存、入库或上架报表。

只读取最后一条 `type="result"` 记录。execute 返回 `ok=true` 且 `files` 非空时，`files` 是最终交付文件唯一真源：当前任务已完成，直接交付 files 并结束；不再读取其他 Skill、搜索 fixture/parser/transcript、再次 preview/execute 或判断文件是否完成。失败时转述真实的脱敏错误；若 `ok=false` 且 `data.partial=true` 并且 `files` 非空，files 是程序确认可交付的部分文件，但不得称完整成功。429、403、验证码或账号异常后不要重复运行命令。
