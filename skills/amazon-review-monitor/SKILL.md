---
name: amazon-review-monitor
description: Analyze recent Amazon.com product reviews, rating distribution, sentiment keywords, and low-rating issue themes. Use when a user asks about review quality, negative feedback, customer complaints, or recent review themes for an ASIN.
type: amazon_operations
commands:
  - lxeskill amazon reviews analyze
license: MIT
---

# Amazon Review Analyzer

本 Skill 对 Amazon.com 的公开商品页和最近评论页做一次性分析，不提供定时监控、告警或 Seller Central 操作，也不需要 Seller 账号或 API Key。

## Command

```text
lxeskill amazon reviews analyze --asin B09B8V1LZ3 --marketplace com --pages 1
```

当前只支持 `marketplace=com`，`pages` 默认为 1、最多为 3。

请求固定使用 LinkFox 原版的 Mac Chrome-like UA；该字符串在 macOS、Windows 和 Linux 上保持不变，只用于公共页面兼容性，不保证绕过 Amazon Guard。

## Result Rules

- `complete`：商品聚合字段和所请求的评论样本均可识别。
- `partial`：商品页可用，但评论正文被 CAPTCHA、登录墙、404 或页面变化阻断；只能转述 `product_summary`，不得声称没有评论。
- `blocked|failed`：商品预检本身被阻断或失败，不得生成评论结论。
- `review_sample` 仅代表本次取得的最近评论，不代表全部历史评价。
- `sentiment` 是英文词表启发式结果，不是 AI 情感模型；置信度低时必须说明限制。
- `internal_actions` 仅供运营排查，不是联系评论者的话术，不得据此主动联系买家。
- 完整评论样本保存在 `report_path`；除非用户明确要求，不读取或发送 diagnostic artifact。
- 不尝试代理轮换、验证码绕过、浏览器指纹伪装或自动重试。
