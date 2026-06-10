我希望之后把各个 agent 的使用数据统一收集到一台服务器。

本地已有两类数据：
1. agent_sessions：session 级统计，比如 token、tool 次数、消息数、时间。
2. session_messages/*.jsonl：聊天记录。

中心服务器用 machine_id + session_id 作为全局 session 标识。
machine_id 由本地 agent 生成和维护，即使被删除也接受，因为只是产生一个新安装实例。

为了让人能看懂是谁在用、哪个机器人在用，每次上传同时带上 agent_session 中的 source

(source 中现在额外加上了 bot 相关信息)