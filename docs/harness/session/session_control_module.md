为了适配可视化页面的 session 页面，我需要在目前的 harness 框架中加入 session 管理模块，我要实现的功能如下：
1. 存储多份 session，用户可以主动创建、删除和复用某个 session
2. /clear 只是创建一个新会话，而不是直接清空所有会话历史

问：复用是指什么
答：切换到就 session，后续消息继续追加到就 session
---

为此，我需要新的两张数据库表格，
agent_chat_session，存储有哪些 session
具体字段如下：
id  // 会话 ID，也就是代码里常说的 session_id。
source  // 会话来源，比如 cli、tui、telegram、api_server、feishu 等（我的项目目前 feishu）
user_id // 
model   // 这个会话使用的模型名。
model_config    // 保存会话创建时的模型相关配置，比如 max iterations、reasoning config 等。
started_at  // 会话开始时间，Unix timestamp。
ended_at    // 会话结束时间。为空表示还没结束。
message_count   // 消息数量计数。append_message() 时递增。
tool_call_count // tool 调用数量计数。assistant 有 tool_calls 或 role 是 tool 时会增加。
input_tokens    // 输入 token 累计。
output_tokens   // 输出 token 累计。
title   // 会话标题。
api_call_count  // 这个 session 内累计的大模型 API 调用次数。


agent_chat_message，存储某个具体的 session 中的上下文
具体字段如下：
id  // 消息行 ID，自增主键。
session_id  // 所属会话 ID，外键指向 sessions.id。
role    // 消息角色：system、user、assistant、tool。
content // 消息正文。多模态内容会被转换/编码后保存。
tool_call_id    // 	tool 结果对应的 tool call ID。通常用于 role='tool' 的消息。
tool_calls  // 	JSON 字符串，保存 assistant 发起的 tool calls。
tool_name   // 	tool 名称。通常用于 tool result 消息。
timestamp   // 	消息时间，Unix timestamp。
token_count // 该消息相关 token 数。不是所有消息都会填。

---

问：目前判断消息来源靠 platform、connector_key，切换成 source 是不是不合适？
答：实际使用中，agent 对应的单个平台只会链接一个 bot，不存在同一平台，多个bot的情况。所以 connector_key 是不是没有存在的必要

问：从 agent_chat_message 的字段来看，是要把上下文中的 message 在数据库中的格式变成一条一条记录，需要时根据 session_id 搜索，然后按照 id 排序吗？
答：是的，id 是 SQLite 自增主键，更能表示真实写入顺序

问：不同的模型供应商支持的上下文协议格式不同，该怎么适配
答：首先，有一个 agent 自己的基础格式。然后假设有多个模型供应商，那么和这些供应商交流的流程大概是 基础格式 -> 适配格式 -> 发送给供应商 -> 得到供应商的信息 -> 把供应商的信息转成基础格式