中断对话时，怎么判断当前 session 是否是‘活’着的呢？

目前应用大概有两种方法：
1. 维护一个列表专门用来存放活动中的 session 的 id。（有一个好处是 列表 放在内存里，进程结束也跟着消失，不用担心维护正确的活跃状态问题）
2. 给 session 本身的字段加上一个 state，如果 state 为 active，那么说明 session 启动了

我的项目中是第二种，而且是比较糟糕的那种，我把这个 state 存到了 sqlite 数据库中，因为 sqlite 中是持久化保存，所以我还必须加上一个启动 agent 时把 session 调成 inactive 的逻辑。

---

我要改成第一种

好的，首先明确一些基础规则
1. session 只是上下文历史和元数据容器，不应该有是否运行的概念
2. 运行的是 agent loop，agent loop 使用了某个 session
3. 同一时刻，一个 session 最多对应一个 active agent loop。

---

具体怎么设计呢
在内存中维护一个 dict，存储有哪些 agent loop 正在运行。
dict 里面，key 是 session_id，value 是 job_id（可以定位到 agent_loop 的东西）

/stop 命令发送时，根据 session_id 找到 job_id，关停

---

关停的流程是什么？
设计流程首先要搞明白哪些是关停当前 loop 的难点
1. 关停时正好在接收供应商发送过来的 stream，

2. tool 正在运行（特别是 exec 运行的命令）

3. 上下文还没有持久化

