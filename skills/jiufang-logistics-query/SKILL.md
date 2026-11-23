---
name: jiufang-logistics-query
description: 用一个 FBA 主号或箱号查询九方通逊公开物流轨迹，无需登录或打开紫鸟。
type: default
commands:
  - lxeskill logistics jiufang query
---

# 九方通逊单票查询

请提供一个完整 FBA 主号或箱号。可选填目的仓，用于核对返回结果。

```text
lxeskill logistics jiufang query --fba <完整FBA或箱号> --expected-warehouse <目的仓>
```

目的仓未知时省略 `--expected-warehouse`。默认将末尾 U 加六位数字识别为箱号后缀；已明确输入是主号时可用 `--identifier-kind shipment` 保留完整编号。查询使用九方公开接口，无需账号配置。

先看返回的 `ok`，再看 `data.identity_verified` 和 `data.matches`。同一运单关联多个 FBA 时，件数、重量和轨迹是整票结果。目的仓不匹配、响应异常或轨迹不完整时，说明实际结果和原因。到港或到仓时间不等于 Amazon 送达时间，转单号原文也不能单独确认承运商。

只查九方时，到这里即可交付。需要核对 Amazon 送达时段时，使用已安装的 `fba-us-logistics-workflow` Skill。九方查询不操作 Amazon。
