---
name: feishu-im-read
description: 飞书 IM 消息读取指南，覆盖 bot 可见群聊的历史消息、话题回复以及图片/文件资源下载。
type: default
---

## When to Use

- 需要获取飞书群聊的历史消息。
- 需要读取话题（thread）内的回复消息。
- 需要下载消息里的图片、文件、音频、视频资源。
- 用户提到“聊天记录”、“消息”、“群里说了什么”、“话题回复”、“搜索消息”、“图片”或“文件下载”。

## How to Execute

先记住这些硬约束：

- 该 skill 中的消息读取工具均以 bot 身份调用，只能读取 bot 已加入且有权限的会话。
- 当前飞书群里直接问“查看历史消息”时，`feishu_im_bot_get_messages` 可以省略 `chat_id`，工具会自动使用当前会话。
- 跨群读取前，优先用 `feishu_im_bot_list_groups` 找到目标 `chat_id`。
- 消息中出现 `thread_id` 时，根据用户意图判断是否用 `feishu_im_bot_get_thread_messages` 读取话题内回复。
- 需要下载资源时，用 `feishu_im_bot_fetch_resource`，并带上 `message_id + file_key + type`。

快速索引：意图 -> 工具

| 用户意图 | 工具 | 必填参数 | 常用可选 |
|---------|------|---------|---------|
| 列出 bot 可见群 | `feishu_im_bot_list_groups` | - | `page_size`、`page_token` |
| 获取当前群或指定群历史消息 | `feishu_im_bot_get_messages` | 当前群可省略 `chat_id`；跨群时传 `chat_id` | `relative_time`、`start_time`、`end_time`、`page_size`、`page_token`、`sort_rule` |
| 获取话题内回复消息 | `feishu_im_bot_get_thread_messages` | `thread_id` | `page_size`、`page_token`、`sort_rule` |
| 下载消息中的图片 | `feishu_im_bot_fetch_resource` | `message_id`、`file_key`、`type="image"` | - |
| 下载消息中的文件/音频/视频 | `feishu_im_bot_fetch_resource` | `message_id`、`file_key`、`type="file"` | - |

时间范围：

- 用户未明确指定时间范围时，要根据意图推断合适的 `relative_time`。
- `relative_time` 与 `start_time/end_time` 互斥，不能同时使用。
- 常用取值：`today`、`yesterday`、`this_week`、`last_week`、`this_month`、`last_month`、`last_{N}_{unit}`。

分页：

- `page_size` 范围 1-50，默认 50。
- 返回 `has_more=true` 时，可用 `page_token` 继续获取下一页。
- 用户要完整结果时继续翻页；只看概览时第一页通常够用。

话题回复：

- 获取历史消息时，如果发现 `thread_id`，默认应补读最新 10 条回复，补足上下文。
- 如果用户要“完整对话”或“详细讨论”，改为完整拉取话题回复并在需要时翻页。
- 话题消息不支持时间过滤，只能分页。

资源提取：

| 资源类型 | 内容中的标记格式 | 下载参数 |
|---------|-----------------|---------|
| 图片 | `![image](img_xxx)` | `message_id` + `file_key=img_xxx` + `type="image"` |
| 文件 | `<file key="file_xxx" .../>` | `message_id` + `file_key=file_xxx` + `type="file"` |
| 音频 | `<audio key="file_xxx" .../>` | `message_id` + `file_key=file_xxx` + `type="file"` |
| 视频 | `<video key="file_xxx" .../>` | `message_id` + `file_key=file_xxx` + `type="file"` |

注意事项：

- 文件大小限制 100MB，不支持下载表情包或卡片中的资源。
- bot 不在群里时，读取会直接失败，不会返回跨会话搜索结果。
- 这版不支持 `search_messages`，也不支持 `open_id -> p2p` 单聊解析。

常见错误与排查：

| 错误现象 | 根本原因 | 解决方案 |
|---------|---------|---------|
| 消息结果太少 | 时间范围太窄或未传时间参数 | 根据用户意图推断合适的 `relative_time` |
| 消息不完整 | 没有检查 `has_more` 并翻页 | `has_more=true` 时用 `page_token` 翻页 |
| 话题讨论内容不完整 | 没有展开 `thread_id` | 发现 `thread_id` 时补读话题回复 |
| `relative_time` 和 `start_time/end_time` 同时使用 | 时间参数冲突 | 选择一种时间过滤方式 |
| 资源下载失败 | `file_key` 或 `message_id` 不匹配 | 确认 `file_key` 来自该条消息 |
| 找不到目标群 | 未提供 `chat_id` 且当前不在飞书群会话，或 bot 不在该群 | 先用 `feishu_im_bot_list_groups` 找 `chat_id`，确认 bot 已加入目标群 |
| 权限不足 | bot 无权限或不在群里 | 确认应用权限和 bot 群成员状态 |
