session 是上下文的唯一归属单位。
session_id 同时负责定位 session 元数据和 message JSONL 文件。

为了适配可视化页面的 session 页面，我需要在目前的 harness 框架中加入 session 管理模块，我要实现的功能如下：
1. 存储多份 session，用户可以主动创建、删除和复用某个 session
2. /clear 只是创建一个新会话，而不是直接清空所有会话历史

问：复用是指什么
答：切换到某个 session，后续消息继续追加到这个 session

---



扩展 agent_sessions，并新增每个 session 一个 JSONL message 文件
agent_sessions，存储有哪些 session
具体字段如下：
session_id  // 会话 ID，也就是代码里常说的 session_id。
source  // JSON，保存 session 的平台来源快照
model   // 这个会话使用的模型名。
model_config    // 保存会话创建时的模型相关配置，比如 max iterations、reasoning config 等。
created_at  // 会话开始时间，Unix timestamp。
last_active_at  // 会话最后一次启用的时间，可以按照这个来排序
message_count   // 当前 JSONL 文件里的 message 行数
tool_call_count // tool 调用数量计数。每调用一次 +1，按实际 LLM tool call 累计
input_tokens    // 输入 token 累计。session 生命周期内累计统计，不随 JSONL 裁剪减少
output_tokens   // 输出 token 累计。session 生命周期内累计统计，不随 JSONL 裁剪减少
title   // 会话标题。
api_call_count  // 这个 session 内累计的大模型 API 调用次数。

然后是 <session_id>.jsonl，每一个 session_id 都是唯一的，所以直接以 session_id 命名。
为什么是 JSONL 文件中，因为 message 本身就是数组，天然适合一行一行存储。
因为是 JSONL 文件，所以持久上下文时按完整 messages 快照重写文件，而不是追加。

sessions.json 用来保存 session_key -> session_id 映射，并附带 origin 快照。比如飞书可以是：
{
  "agent:main:feishu:group:oc_xxx:on_xxx": {
    "session_key": "agent:main:feishu:group:oc_xxx:on_xxx",
    "session_id": "20260603_143000_ab12cd34",
    "created_at": "2026-06-03T14:30:00+08:00",
    "updated_at": "2026-06-03T14:30:00+08:00",
    "origin": {
      "platform": "feishu",
      "chat_id": "oc_xxx",
      "chat_type": "group",
      "user_id": "ou_xxx",
      "user_id_alt": "on_xxx"
    },
    "platform": "feishu",
    "chat_type": "group"
  }
}
其中的 session_id 就是 agent_sessions 中的 session_id，session_key 由 gateway 生成和 session_id 是映射关系。（系统内部会根据 session_key 找到 session_id）


---



问：不同的模型供应商支持的上下文协议格式不同，该怎么适配
答：首先，有一个 agent 自己的基础格式。然后假设有多个模型供应商，那么和这些供应商交流的流程大概是 基础格式 -> 适配格式 -> 发送给供应商 -> 得到供应商的响应 -> 把供应商的响应转成基础格式