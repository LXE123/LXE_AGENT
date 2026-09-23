# 智汇 TMS 菲律宾阶段 4 交接：下载与 XLSX 交付

## 范围

本阶段在阶段 2/3 的 Client 和分页结果之上实现：

- 导出地址的 HTTPS、可信域名、无重定向校验。
- 下载响应的 MIME、文件大小和 XLS/XLSX 文件头校验。
- XLS 与 XLSX 的读取和统一写出为分页 `.xlsx` 文件。
- 分页文件命名、表头一致性检查、按分页顺序合并。
- 绝对路径 `artifacts[]`，每个分页文件和合并文件独立返回。
- 下载或合并失败时保留已生成的分页文件，不返回伪造的合并 artifact。

本阶段没有实现 Skill、Intent、Planner、Catalog、CLI 注册、Desktop 联调或生产 E2E。

## 修改

- `python/lxeskill_cli/services/zhihui_tms/client.py`
  - 增加受限 `download_bytes`，复用 timeout、重试和退避策略。
  - 不向下载域名发送 apiToken Header；Session 仍负责合法 Cookie。
- `python/lxeskill_cli/services/zhihui_tms/xlsx_delivery.py`
  - 增加 XLS/XLSX 解析、表头/行宽验证、原子写文件和合并结果。
- `python/lxeskill_cli/services/zhihui_tms/__init__.py`
  - 暴露 artifact、交付结果、交付异常和入口。
- `python/lxeskill_cli/tests/zhihui_tms/`
  - 增加下载安全、XLS/XLSX 读取、命名、合并、失败保留和 artifact 测试。

## 关键决策

1. 默认只允许 `https://tms-cos.mabangerp.com` 下载；HTTP、非可信域名、用户信息、非标准端口和重定向均停止。
2. 只接受 XLS/XLSX 文件签名，拒绝错误 MIME、超限响应和非法文件头；下载按 chunk 读取并有最大字节数。
3. 源文件无论是 XLS 还是 XLSX，都经过验证后统一写成目标要求的 `.xlsx` 分页文件。
4. 每个分页先独立落盘，再检查与前页表头是否一致；表头冲突时保留已经落盘的分页文件，但不生成合并文件。
5. 合并工作簿只写一次表头，并按 `export_result.pages` 顺序追加数据；返回路径全部是绝对路径。
6. 空分页结果返回空 `artifacts[]`，不凭空创建无表头的合并文件。

## 测试

从仓库根目录运行：

```text
UV_CACHE_DIR=/private/tmp/lxe-uv-cache uv run pytest python/lxeskill_cli/tests/zhihui_tms -q
```

结果：阶段 2、3、4 合计 `39 passed`。

覆盖内容包括：

- 下载 HTTPS/可信域名/重定向/MIME/文件头/大小/超时和流式读取重试。
- XLS 和 XLSX 读取分支。
- 分页文件与合并文件的日期命名、绝对路径、artifact 类型和顺序。
- 单表头合并、表头不一致、下载失败、空结果和失败时保留分页文件。

## 风险与下一步

- 当前未连接真实 TMS 下载地址，真实响应的 MIME、文件头和下载 Cookie 仍需在人工授权的低频探针中确认。
- 当前只读取每个工作簿的第一个工作表；如果真实导出包含多工作表且业务要求全部保留，需要先确认契约再扩展。
- 下一阶段应接入正式 Python CLI、Skill、Intent、Planner 和 Catalog，并沿用本阶段的 `artifacts[]` 与错误契约。
- Desktop 联调前必须完成权限 scope、凭据注入、preview 和 fail-closed 验收。
