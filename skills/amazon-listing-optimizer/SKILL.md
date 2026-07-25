---
name: amazon-listing-optimizer
description: Experimental Amazon.com listing analysis, autocomplete keyword research, and competitor discovery. Use when a user asks to score or improve an Amazon listing, research Amazon SEO keywords, inspect competing ASINs, or compare these results with Helium 10 or Jungle Scout.
type: amazon_operations
commands:
  - lxeskill amazon listing analyze
  - lxeskill amazon keywords research
  - lxeskill amazon competitors research
license: MIT
---

# Amazon Listing Optimizer

本 Skill 是实验性研究工具，不是正式运营数据源。Amazon 可能返回 Robot Check、简化页面或变化后的 HTML；必须根据命令返回的 `status`、`diagnostics.confidence` 和 `diagnostics.missing_fields` 判断结果是否可用。

## Routing

| 用户需求 | 命令 |
|---|---|
| 分析 ASIN、Listing 质量、标题/五点/图片/评论 | `lxeskill amazon listing analyze` |
| Amazon SEO、长尾词、搜索建议 | `lxeskill amazon keywords research` |
| 搜索词下的竞品、头部 ASIN | `lxeskill amazon competitors research` |

当前只支持 `marketplace=com`。不要猜测或改写为其他国家站点。

## Result Rules

- `status=complete`：页面结构和关键字段完整，可转述结果。
- `status=partial`：只转述已观测字段，并明确缺失项；不得自行补全总分、等级或竞品结论。
- `status=blocked|failed`：说明真实错误和诊断，不得把空结果解释成“没有数据”。
- 报告文件是诊断产物，不主动调用 `send_file`；用户明确要求时再读取或发送。
- 不尝试代理轮换、验证码绕过、浏览器指纹伪装或重复重试。

## Commands

```text
lxeskill amazon listing analyze --asin B0DC6F1MTD --marketplace com
lxeskill amazon keywords research --seed "seasoning blend" --marketplace com --depth 1
lxeskill amazon competitors research --query "garlic seasoning organic" --marketplace com --limit 5
```
