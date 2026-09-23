---
name: shangman-goods-export-workflow-map
description: 用户当前轮明确提到“上马”“上马印尼”或“Shangman”，并查询商品、销量、库存、入库时间、上架时间、月末库存、月末快照、7/14/30/90 天销量、90 天日度销量或最近一个月销量时使用的唯一上马印尼商品原始导出入口；所有表达都只执行一次 goods_export 并交付一个原始 XLSX。当前轮平台优先于历史 Context；不用于雅仓、智汇/TMS 或马帮。
type: replenishment
commands:
  - lxeskill shangman export preview
  - lxeskill shangman export run
---

# 上马印尼商品导出

## 入口和语义

- 这是上马印尼商品原始导出的唯一公开 Skill。用户只明确说“上马”时，按当前唯一支持的印尼平台填充 `country: "印尼"`；不要追问用户客户端认证或底层参数。
- 当前轮明确的平台、数据类型和时间高于历史 Context。只有用户说“刚才”“同上”“还是那个”时才继承缺失参数；当前轮明确雅仓、智汇/TMS 或马帮时不使用本 Skill。
- 上马印尼商品、销量、库存、库存加销量、入库时间、上架时间、月末库存、月末快照、7/14/30/90 天销量、90 天日度销量和最近一个月销量都只表示同一个 canonical intent：`goods_export`。
- 上述表达无论出现一个还是多个，参数都固定为 `{"platform":"上马印尼","country":"印尼","operation":"goods_export"}`；不把指标、周期、日期或快照类型传入执行层。

固定参数逐项如下，除此之外不传其他业务参数：

```yaml
platform: "上马印尼"
country: "印尼"
operation: "goods_export"
```

- “上马印尼月末库存”“上马印尼月末快照”“上马印尼8月底库存”仍执行当前商品原始导出，不追问日期、不新增历史快照任务，也不宣称文件重建了历史月末状态。
- “上马印尼库存和销量”“上马印尼销量、库存和上架时间”“上马印尼90天日度销量”都只执行一次 `goods_export`，只返回一个原始 XLSX。
- 源文件只按平台实际导出的字段交付。产品文字不能声称该文件包含 14 天字段、90 天逐日明细或历史月末字段。

## 执行

- 用户已明确要查询或导出，且结构化参数齐全时，直接调用 `run`，不先执行重复校验的 `preview`。
- 只有用户明确要求预览执行计划时，才调用 `lxeskill shangman export preview --params '<JSON>'`。
- 正常执行唯一调用为 `lxeskill shangman export run --params '{"platform":"上马印尼","country":"印尼","operation":"goods_export"}'`；不得按指标或周期拆成多次调用。
- 最后一条 terminal 满足 `ok=true` 且 `files` 恰好包含一个真实 XLSX 时，立即交付并结束；不再查 fixture、parser、transcript 或其他 Skill，不再次调用 `run`。
- 成功只说明“已完成上马印尼商品原始报表导出”，不得把用户原话中的周期、日度或月末表述包装成文件实际不存在的字段。
- 失败必须保留 terminal 的真实脱敏 `error.code`、`error.message` 和 `data.recoverable`，且 `files=[]`；没有 artifact 时不能猜测文件名或路径。

## 验证码与认证

- `run` 只复用按账号和凭据指纹持久化的有效认证状态；存在有效 token 时，直接执行一次商品导出，不获取验证码、不调用登录命令。
- 没有 token、token 过期或 ERP 返回 401 时，终态返回真实的 `login_required`；401 仅使被拒 token 失效，Python 不会自动登录或重试 ERP 导出。
- 此时把独立 `shangman-login` Skill 作为认证恢复前置步骤。登录成功后，调用方最多恢复原 `run` 一次；这是 Skill/Agent Contract，不是 Runtime 跨回合代码级计数器。恢复导出再次失败时直接交付真实失败，不循环登录或导出。
- 验证码只允许出现在独立登录恢复的例外路径。不得把验证码图片、验证码文字、`challenge_id` 或凭据放进导出命令、terminal data、transcript 或日志；不猜测、不暴力尝试、不绕过平台验证。

## 交付边界

- 文件名由持久化认证导出器统一为 `上马-商品-YYYYMMDD-HHMMSS.xlsx`。
- 交付的是平台原始 XLSX；不在 Skill 层重写、补列、合并或伪造日度历史数据。
- 生产门禁和 Desktop 凭据设置由 Desktop 管理；导出路径不创建验证码等待通道。
