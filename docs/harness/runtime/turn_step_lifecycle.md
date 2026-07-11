# Turn Step Lifecycle

状态：Current

一次 step 的固定顺序是：cancel/steering checkpoint → context prepare/compaction → 读取当前 exposure schemas → provider attempt → 持久化 assistant content → tool dispatch → 持久化闭合的 tool results → 下一 step 或 final。

`tool_search` 在本 step 暴露匹配结果，模型从下一 step 才能调用；读取 `SKILL.md` 同理激活 owner tools。任何失败只结束当前 provider attempt、tool call 或 turn，不得使 Gateway 进程退出。
