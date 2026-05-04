---
name: coze-workflow
description: 用户要求批量替换图片背景时，请使用这个 SKILL
type: default
---

# 商品图片批量换背景

## 触发条件
- 用户表达批量换背景意图（如“批量换背景/替换为某某背景/压缩包图片处理”）。

## 必填参数
- `archive_file_path`（`.zip` 或 `.7z`）  (压缩包中包含多张图片)
- `prompt_text`  （替换背景的提示词，需要你根据用户的发言填写）

缺参数先追问，不执行。

## 固定执行（后台运行任务）
```json
{
  "tool": "exec",
  "args": {
    "command": "uv run --frozen python -X utf8 \"skills/coze-workflow/scripts/ImgBackgroundBatchReplace.py\" --archive-file-path \"{archive_file_path}\" --prompt-text \"{prompt_text}\"",
    "background": true
  }
}
```

该脚本返回结果中会输出：
- `RESULT_FILE_PATH`
- `RESULT_FILE_ACTION=send_to_user`
- `RESULT_NOTICE=请把该结果文件路径中的文件发送给用户。`

处理规则：
- 优先读取 `RESULT_FILE_PATH` 作为结果文件路径
- `RESULT_NOTICE` 只是发送提示，不参与路径解析
- 拿到 `RESULT_FILE_PATH` 后，把这个字段里的文件发送给用户
- 这是一个后台任务脚本，运行后，如果没有其它要做的事，可以直接结束当前对话。

