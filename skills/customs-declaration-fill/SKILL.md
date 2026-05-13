---
name: customs-declaration-fill
description: 根据用户上传的备货 xlsx 填写报关资料模板，生成申报要素 sheet 已填好的报关资料文件。
type: amazon_store
---

## When to Use

- 用户发送备货 xlsx，并要求“填写报关单”“填写报关资料”“生成报关资料”等。
- 文件名通常类似 `4.26-SP260414001-新棱镜备货-美国（4.28）-2.xlsx`，其中 `SP260414001` 是发货单号。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration`
- 不要手动编辑用户上传的 xlsx。
- 不要手动编辑 `data/customs_declaration/custom_declaration_documents.xlsx`。
- 模板原件不能修改，CLI 会复制模板到 `artifacts/customs_declaration/` 后填写副本。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有一个用户提供的 `.xlsx` 文件路径。
- 文件名中必须包含 `SP...` 发货单号。
- 如果用户没有提供 xlsx 文件，先追问文件。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration --input-xlsx <uploaded_xlsx_path>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "sp_no": "SP260414001",
  "input_xlsx": "...xlsx",
  "output_xlsx": "artifacts/customs_declaration/SP260414001_custom_declaration_documents.xlsx",
  "row_count": 12,
  "unmatched_count": 1,
  "notice": ["第5行未匹配申报规则: 商品名称=..., 品名=..."],
  "source": "customs_declaration_fill"
}
```

失败时：

```json
{
  "success": false,
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户报关资料文件已生成，并提供 `output_xlsx`。
- 如果 `unmatched_count > 0`，提醒用户有未匹配申报规则的行，并转述 `notice`。
- `success=false`：只转述 `exception`。
