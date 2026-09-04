---
name: shopee-keyword-search
description: 查询海鹰数据平台的 Shopee 关键词搜索量，按国家抓取并导出 Excel 汇总报表；也用于查看/更新默认搜索关键词，以及查询已生成报表里的数据。当用户说“Shopee关键词导出并汇总”“关键词搜索量查询”“海鹰关键词查询”“把关键词换成 XX”或要求分析 Shopee 各站点关键词搜索热度时使用。
type: default
commands:
  - lxeskill shopee keywords export
  - lxeskill shopee keywords query
  - lxeskill shopee keywords config
license: MIT
---

# Shopee 关键词搜索量导出并汇总

登录海鹰数据平台，按关键词和国家抓取 Shopee 搜索量数据，整理为 Excel 报表交付。支持随时更换默认搜索关键词。

覆盖 9 个 Shopee 站点：越南、泰国、印尼、巴西、马来西亚、台湾、菲律宾、新加坡、墨西哥。

## 命令

### 抓取并导出报表（主流程）

```text
lxeskill shopee keywords export
```

- `keywords`（可选，数组）：本次要抓取的关键词；省略时使用 `config` 保存的默认词表。
- `countries`（可选，数组）：要抓取的国家（中文名、英文别名或代码均可，如 `泰国`、`Thailand`、`3`）；省略时抓取全部 9 个站点。

每个（国家 × 关键词）查询强制翻完全部分页。成功后 Excel 作为 deliverable 交付；`keyword_source` 标明本次词表来自参数还是默认词表。

### 查询已有报表（不重新抓取）

用户问“Excel 里 XX 国家的 XX 关键词搜索量是多少”“XX 国搜索量最高的是哪些词”时，**不要重新抓取**，直接查询：

```text
lxeskill shopee keywords query --list-countries
lxeskill shopee keywords query --country 泰国 --keyword "apple watch" --top 10
lxeskill shopee keywords query --country 泰国 --top 10
lxeskill shopee keywords query --keyword "apple watch" --top 5
```

`top` 结果已按搜索量降序。把结果整理成易读表格呈现给用户。报表不存在时命令会明确报 `report_missing`，此时提示用户先跑 export。

### 管理默认关键词

```text
lxeskill shopee keywords config --action get
lxeskill shopee keywords config --action set --keywords garmin --keywords "apple watch"
```

- 用户说“把关键词换成 / 搜索词改成 A, B, C”时：先从用户输入提取关键词列表（去重去空、保留原始大小写和内部空格），调用 `set` 保存，然后向用户确认词表并询问是否立即执行 export。
- 更新后的词表持久保存；之后用户只说“关键词搜索量查询”就用最新词表，无需重复指定。

## 凭据配置

海鹰账号密码**不在仓库中**，命令按以下顺序解析凭据：

1. 环境变量 `LXE_HAIYING_USERNAME` / `LXE_HAIYING_PASSWORD`；
2. 本地配置文件 `<var>/lxeskill/shopee/haiying_credentials.json`（`{"username": "...", "password": "..."}`）。

未配置时命令返回 `credentials_not_configured` 及配置指引，请把指引原样转达给用户，不要猜测或编造账号。凭据只用于登录海鹰，不会出现在命令输出中。

## 结果规则

- 报表布局：每个国家一个 Sheet；Sheet 内每个关键词占 2 列（搜索词/搜索量），块之间空 1 列；第 1 行关键词标题，第 2 行表头，第 3 行起数据。
- 一次性 CLI 进程没有跨进程 Token 缓存，每次 export 都会重新登录海鹰，这属于正常现象。
- 抓取中 Token 失效时命令自动重新登录并重试当页；单请求最多重试 4 轮、指数退避。
- `authentication_failed`：提示用户检查凭据是否过期或海鹰平台状态，不要重试轰炸。
- 网络错误按 `network_error` 如实转述；Excel 生成失败检查磁盘与占用（Windows 下报表被 Excel 打开会覆盖失败，关闭后重跑）。

## 站点与代码对照

| 站点 | 代码 | 别名 |
| --- | ---: | --- |
| 马来西亚 | 1 | 马来 / Malaysia / MY |
| 印尼 | 2 | 印度尼西亚 / Indonesia / ID |
| 泰国 | 3 | Thailand / TH |
| 菲律宾 | 4 | Philippines / PH |
| 台湾 | 5 | Taiwan / TW |
| 新加坡 | 6 | Singapore / SG |
| 越南 | 7 | Vietnam / VN |
| 巴西 | 8 | Brazil / BR |
| 墨西哥 | 11 | Mexico / MX |

配置外国家可用 `名称:代码` 形式传入（如 `Chile:9`）。
