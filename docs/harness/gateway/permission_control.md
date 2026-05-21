FBA 模块的 SKILL （分类为 amazon-fba）目前已经编写好了，很快就要编写 FBA 模块之外的 skill 了。我认为现在就是做好权限管理的时候。
这个权限管理不止是对业务人员的也是对 agent 本身的。
---
我的设想如下，
目前这个 agent 已经通过 ps 脚本（在 scripts 里）实现快速安装和快速部署。
通过 config 来配置太不安全了，可以很简单就被修改，而且需要每台电脑我过去手动修改。
那么我们可以通过什么来实现呢？
网关 gateway。
目前 Agent 接收任何消息，都要经过网关，所以在网关，我们可以看到是哪个用户发送了信息。
用户发消息时是发送给 bot 的，bot 是在本地 config 绑好的，我会参与到所有的 agent 部署中，意味着我也知道所有 bot 的 key 和 secret。
所以，我们就可以通过 bot 和用户为中心，实现权限管理
---
# Gateway 做权限决策
首先 bot_id 是决定了该 agent 能看到哪些 skill。比如现在有两个 bot，一个是 LXE_FBA_AGENT，一个是 LXE_claw。
那么 LXE_FBA_AGENT 永远只能看到分类为 amazon-fba 的 skill。
而 LXE_claw 是可以看到全部的。
---
然后 user_id 决定了谁能用哪些 agent，FBA 业务人员的 id 理应只能访问 LXE_FBA_AGENT，而开发人员的 ID 是可以和所有 agent 对话的。
---
bot_id 控制能力边界，user_id 控制访问边界。

---

# 权限控制方案V1
---
所有消息都会先进入 Gateway，那么就由 Gateway 统一做权限判断。
权限判断分两层：
1. user_id 控制访问边界
 判断“这个用户能不能使用这个 Bot / Agent”。
 例如： 
 FBA 业务人员只能访问 LXE_FBA_AGENT 
 开发人员可以访问所有 agent
2. bot_id 控制能力边界
 判断“这个 Bot / Agent 能看到哪些 skill”。
 例如：
 LXE_FBA_AGENT 只能看到 amazon-fba 类型的 skill
 LXE_claw 可以看到全部 skill
---


## skill 怎么分类？
目前每个 skill 中都有 type，根据这个 type 来判断。然后 agent 是怎么调用 skill 呢？
是在上下文中看到的，所以需要在 agent 的上下文管理模块中做控制。

---

有 agent_id 吗？可以说 bot_id 就是 agent_id，因为一个 bot 只会链接一个 agent。
