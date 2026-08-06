# 退役飞书本地权限策略

日期：2026-08-06

Gateway 不再维护 Bot ID 或 union ID 白名单，也不再用飞书身份决定 Skill 可见范围。飞书后台的应用可用范围负责用户准入；Gateway 只验证事件属于当前 App，并继续要求群聊明确 @ 当前 Bot。

设备业务权限是 Skill 可见与可执行范围的唯一来源，通过 Desktop Cloud 下发并由 Agent Runtime 热更新。飞书 App、Bot 和用户标识继续用于会话路由、回复、统计与审计，不参与授权。

因此删除 Gateway 的 `security` 源码与测试目录、桌面权限策略资产、Python loader、管理脚本及内部协议中的策略路径。仓库结构冻结集同步移除 Gateway `security` 域。
