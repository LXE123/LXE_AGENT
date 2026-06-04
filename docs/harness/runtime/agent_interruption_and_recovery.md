中断对话时，怎么判断当前 session 是否是‘活’着的呢？

目前应用大概有两种方法：
1. 维护一个列表专门用来存放活动中的 session 的 id。（有一个好处是 列表 放在内存里，进程结束也跟着消失，不用担心维护正确的活跃状态问题）
2. 给 session 本身的字段加上一个 state，如果 state 为 active，那么说明 session 启动了

我的项目中是第二种，而且是比较糟糕的那种，我把这个 state 存到了 sqlite 数据库中，因为 sqlite 中是持久化保存，所以我还必须加上一个启动 agent 时把 session 调成 inactive 的逻辑。

---

我要改成第一种