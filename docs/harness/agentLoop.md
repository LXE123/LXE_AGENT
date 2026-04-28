一次 turn 是什么？
- 用户发消息直到 agent 回复算做一次 turn

一次 loop 是什么？
- 不完全固定，这可以大概认为每使用一次 tool 后，更新上下文前的那一刻算做一次 loop 结束

一次 loop 可以调用几次工具？
- n 次
- llm可能会返回多个 tool call
    ```js
    if response.has_tool_calls:
        # 第 225-232 行：逐个执行
        for tool_call in response.tool_calls:
            result = await self.tools.execute(tool_call.name, tool_call.arguments)
    ```

llm 返回了什么信息系统可以当做这轮 turn 结束了
- llm 会返回两种信息
- 大致像这样：
- 第一种：{
  "role": "assistant",
  "content": "我已经查完了，结论是……"
}
- 第二种：{
  "role": "assistant",
  "tool_use": {
    "name": "read",
    "input": {
      "path": "README.md"
    }
  }
}
- 一般返回第一种可以当做结束

---

在 loop 进行过程中，项目内部是怎么接收模型供应商返回的 response 的？
- 流式接收，并不是等待模型供应商一次返回所有文本，而是流式读取

---

20260404
你认为这个项目的agent建立了一个好的 feedback loop 了吗？可以自己验证自己的结果，反复调整，直到任务完成的优秀的，能让AI充分发挥自己能力的架构搭建起来了吗