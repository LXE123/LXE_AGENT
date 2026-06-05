让我来总结一下，

1. 该项目里的所有进程的出站流量直连目标服务器，不经过本地代理软件。
2. 同步 HTTP 分成 4 种会话（session），分别管理 LLM API、OCR、外部服务、本地服务（紫鸟）的网络请求。
3. 异步 HTTP 又分为 2 种 session，分别管理 ERP 和外部服务请求。
4. websocket 由一个链接包装器控制，控制是否走代理，ping 间隔，websocket的诞生时间和死亡时间。
   默认参数：
   proxy = None # 显式不走代理
   ping_interval = 60 # 库内置 keepalive，每 60 秒一次
   ping_timeout = None # 只保活不判死，不引入额外断线敏感度
   open_timeout = 30 # 30s 内未建立成功就放弃
   close_timeout = 10 # 10s 内未关闭直接掐断

- websocket 经过 TCP 三次握手，外加一次 HTTP 升级（Upgrade）握手建立。
- 为什么不关心 pong，假设我设置 ping_timeout = 10，某次网络卡顿，11s 后才返回 pong，但这时因为系统判定过期，直接把该链接杀了，新建立了一条链接。
  ping_timeout = None 后，意味着检测链接死活的责任完全交给了底层的 TCP 协议

5. 所以总共有 7 种网络 session 类型。
