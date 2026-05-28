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

权限判断分两层：
1. user_id 控制访问边界
 判断“这个用户能不能使用这个 Bot / Agent”。
 在 gateway 实现（ if/else 判断）。
 例如： 
 FBA 业务人员只能访问 LXE_FBA_AGENT 
 开发人员可以访问所有 agent
2. bot_id 控制能力边界
 判断“这个 Bot / Agent 能看到哪些 skill”。
 在组装上下文时实现（ if/else 判断）
 例如：
 LXE_FBA_AGENT 只能看到 amazon_fba 类型的 skill
 LXE_claw 可以看到全部 skill
---


## skill 怎么分类？
目前每个 skill 中都有 type，根据这个 type 来判断。然后 agent 是怎么调用 skill 呢？
是在上下文中看到的，所以需要在 agent 的上下文管理模块中做控制。

---

有 agent_id 吗？可以说 bot_id 就是 agent_id，因为一个 bot 只会链接一个 agent。


第一批
1. user_id：
lyx: ou_0493c1935b93341d48c6bb456df12063    // Developer, can access all AGENTs
zgl: ou_965bb6cee1c170b16fbe00b5d4b348be    // FBA Module Business Specialist, Can access FBA_AGENT

经过仔细研究后终于找到了 一个可以在 bot 之间共通且相同的 id，也就是 `union_id`，原始数据如下
```bash
➤ 2026-05-28 18:06:04,372 INFO     [FeishuDebug] raw_message_receive_event={"challenge": null, "ts": null, "uuid": null, "token": null, "type": null, "schema": 
"2.0", "header": {"event_id": "efb15d718be82dbd8beee1b8f99d7676", "token": "", "create_time": "1779962764113", "event_type": "im.message.receive_v1", "tenant_key": "14996c395ed4d75d", "app_id": "cli_a97ac28237781bd8"}, "event": {"sender": {"sender_id": {"user_id": null, "open_id": "ou_7ce2a0ec83356336d5187a6fee0ebbd3", "union_id": "on_09af343a868258c25a3e53ad0464caa4"}, "sender_type": "user", "tenant_key": "14996c395ed4d75d"}, "message": {"message_id": "om_x100b6eb5767a0098b2c1526a19b1d95", "root_id": null, "parent_id": null, "create_time": "1779962763596", "update_time": "1779962763713", "chat_id": "oc_86984522ba8288160e542abb82262fe6", "thread_id": null, "chat_type": "group", "message_type": "text", "content": "{\"text\":\"@_user_1 你好\"}", "mentions": [{"key": "@_user_1", "id": {"user_id": null, "open_id": "ou_b3655d3b87d90da8cf254e8d8bf395ca", "union_id": "on_7306f0fd821b14438052de877dde698c"}, "name": "AMAZON-FBA", "tenant_key": "14996c395ed4d75d"}], "user_agent": null}}}
```

对 ID 的权限分配如下
"union_id": "on_ceda19124b8eef9e07c9e7aaec989043" # ZQY  // FBA Module Business Specialist, Can access FBA_AGENT

"union_id": "on_a71a8f244e06602e0f37b3abe68d6ac3" # LYX  // Developer, can access all AGENTs

"union_id": "on_09af343a868258c25a3e53ad0464caa4" # ZGL  // Developer, can access all AGENTs
---

2. bot_ID(app_ID):
LXE_CLAW: cli_a93d57dc47385cc0  // Developer agent, capable of utilizing all skills.
LXE_FBA_AGENT: cli_a97ac28237781bd8 // FBA business module agent, utilizing skills with the `amazon_fba` type.
Amazon_备货：cli_aa9d657db5385cdd // Amazon replenishment module agent, utilizing skills with the `amazon_replenish` type.

目前的 gateway 是可以链接到多个 bot 的，比如说可以链接到飞书和钉钉，所以会担心一个问题，万一有人特意链接到钉钉上然后对话怎么办？
我觉得其实是不用担心的，因为我们可以只允许白名单里 bot_id 发来的信息发送给 agent，这种情况下绑定到多个 bot 也没用。（gateway 控制）  

---

虽然说设计成 LXE_CLAW 可以看见所有 skill，但是我是必须加上一个手动控制 skill 可见范围的功能。这样才方便测试不同 SKILL 可见范围的情况下 AGENT 的发挥表现。

