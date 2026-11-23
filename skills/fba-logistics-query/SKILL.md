---
name: fba-logistics-query
description: 列出已配置物流账号、使用已保存凭据登录并准备物流查询页面。FBA 查询、官方尾程和改期使用独立安装的 fba-us-logistics-workflow
  业务包。
type: ziniao_browser
commands:
- lxeskill logistics profiles
- lxeskill logistics login
---

# 物流账号与登录

飞沃与 UPS/FedEx 一样使用公开追踪页直接查询，不需要登录或物流账号配置。飞沃打开 `http://feichi.nextsls.com/tracking/app` 后执行业务包的 `scripts/feiwo.py`，传入货件号，不传 `profile_id`。

需要账号的威飒、云驼、天泰分别对应 `wesa`、`yuntuo`、`tiantai`，使用 `lxeskill logistics profiles --provider <provider>` 取得启用账号。用途字样如“出口退税”不要求与配置名、用户名或公司名相同。已有该物流商的已登录页面直接复用；需要登录且有多条启用配置时，按返回顺序使用第一条，记录实际配置名。只有需要登录的物流商没有启用配置时才报告配置缺失。保存和修改账号继续使用桌面“物流商配置”。查询所需公司名从当前页面读取。

需要提交凭据且已有授权时执行 `lxeskill logistics login --profile-id <profile_id> --store-id <当前运行店铺ID>`；密码由 Desktop 保管并通过私有执行链路使用，不进入模型参数。已有登录态直接复用，登录或验证码失败保留实际错误。

Amazon 送达时段、威飒/飞沃/云驼/天泰查询及 UPS/FedEx 尾程由独立安装的 `fba-us-logistics-workflow` 提供。读取已安装业务包的说明，然后通过 `lxeskill browser script run` 执行对应脚本。

九方仍由其独立 Skill 和公开查询命令提供，不在本轮 US 业务迁移范围。
