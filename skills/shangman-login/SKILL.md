---
name: shangman-login
description: 使用图片验证码登录上马 ERP 或雅仓 ERP，保存供后续命令复用的登录态；也可查询或清除本地登录态。用于独立登录或已授权数据采集的认证前置步骤。
type: replenishment
commands:
  - lxeskill shangman login prepare
  - lxeskill shangman login submit
  - lxeskill shangman login status
  - lxeskill shangman login clear
  - lxeskill yacang login prepare
  - lxeskill yacang login submit
  - lxeskill yacang login status
  - lxeskill yacang login clear
---

# 图片验证码登录：上马与雅仓

本 Skill 为上马和雅仓提供图片验证码登录，以及本地登录态查询和清除。先确认目标平台；上马 ID、账号和密码，以及雅仓手机号和密码，分别在桌面对应设置中配置。缺少配置时说明实际缺项。凭据和登录态由 CLI 管理。

| 平台 | 命令前缀 | 登录态 |
| --- | --- | --- |
| 上马 | `lxeskill shangman login` | 本地检查保存的 token 和记录的到期时间 |
| 雅仓 | `lxeskill yacang login` | 本地检查 token 是否存在，平台有效期尚未确认 |

## 登录

1. 使用对应平台的 `prepare` 命令获取验证码图片和 `challenge_id`，例如 `lxeskill yacang login prepare`。用户明确要求登录或重新登录时获取新图片。
2. 用 `read` 查看返回的 `data.image_path`，识读当前图片中的验证码并保留大小写。
3. 使用同一平台的 `submit --challenge-id "<实际编号>" --captcha-code "<识读的字符>"` 提交。每个编号只提交一次，包括超时等结果不确定的情况。看不清或平台明确提示验证码错误时，重新 `prepare` 获取新图片并识读；两种情况合计最多刷新两次。仍无法登录时停止并说明实际情况。
4. 读取最后一条 `type="result"`，检查顶层 `ok` 和 `data` 中的 `login_succeeded`、`persisted`；登录和保存均成功后才报告成功。上马返回的 token `expires_at` 转为用户当地时间报告；平台未提供有效期限时采用本地默认 300 秒。雅仓的 token 有效期尚未确认。

独立登录成功后结束；作为已授权导出的前置步骤时，保存成功后返回原导出 Skill 继续任务。命令仍在运行时等待同一次执行。CLI 使用桌面注入的应用状态根目录管理凭据和登录态。

## 状态、清除与失败

对应平台命令前缀后加 `status` 查询本地登录态，加 `clear` 清除本地登录态。状态查询不代表平台在线验证，清除也不代表平台注销。雅仓返回 401 后需重新登录；任一平台返回 403、429 或明显风控时立即停止。

失败时说明 `data.error` 和顶层 `error.message` 中的实际脱敏诊断。账号、网络等其他错误不当作验证码错误重试。每次重新登录均使用新图片和新编号。

`login_succeeded=true` 且 `persisted=false` 表示平台登录成功但本地保存失败，报告实际结果，不为保存失败再次登录。
