# 桌面通过 CLI 查询 Skill 权限

桌面通过独立 CLI 查询服务器授予当前设备的 Skill 范围。服务器决定授权，CLI 负责通信，桌面缓存结果并将 `permission.grants.skill_types` 同步给 Agent。模板名称不会在本地转换成额外权限。

```text
桌面 → lxeskill cloud-context → /api/v1/device-context → 服务器当前权限
```

## 查询命令

```bash
lxeskill cloud-context --server http://10.88.0.1:8000
```

省略 `--server` 时读取 `LXE_DATA_SERVER_URL`。该命令在业务初始化前运行，不需要桌面、Agent、模型、业务 Token、Skill 授权或业务数据库，不创建数据库。只调用设备上下文 API，不检查马帮。

成功时 stdout 输出一条协议版本 `1` 的 JSON 结果：`command` 为 `cloud-context`，`data.device_context` 为服务器的 `lxe.device-context.v1` 结构。失败保留实际错误及可取得的 HTTP 状态，进行必要脱敏和明确截断。退出码为成功 0、参数错误 2、通信失败 3、HTTP 或响应契约错误 4；取消为 130。

使用公共 CloudClient，不发送 Authorization/Cookie，不使用系统代理、重定向或自动重试。请求超时 10 秒、读取上限 1 MiB，超限数据不得作为完整权限。`cloud-status` 复用设备上下文查询，但仍额外检查马帮权限，是诊断命令，不是桌面的授权查询入口。

## 桌面行为

桌面使用受管 Python 绝对路径启动 `-I -B -X utf8 -m lxeskill cloud-context`，不经过 shell，不注入业务、模型或设备根凭据。进程总超时 15 秒，stdout 上限 2 MiB，stderr 保留 4 KiB。非零退出仍解析合法的结构化错误；无效或矛盾输出不会变成成功。

启动、接入完成、手动重试和每 60 秒轮询均查询权限。同轮请求合并；设备切换、停止时取消，并拒绝旧绑定的迟到结果。核对设备 ID 和 WireGuard IP，保留分配版本、模板版本及内容一致性检查。Skill 范围正常更新使用现有热更新通道，不因此重启网关。

临时断网或 CLI 出错时沿用已验证缓存，明确标记缓存。401/403 或设备身份不匹配时，清除内存和持久化缓存，下发空 Skill 范围。服务器返回收权或空授权时直接应用，不能叠加旧权限。旧 identity/activation 的权限字段不再参与在线授权更新，不回退旧接口。

`desktop_features` 仍负责桌面功能入口；它与 Skill 范围、业务 API 权限分别处理。管理员身份仍由原 identity 流程确认，不从 context 的设备类型推导。

## 尚未迁移的部分

服务器地址配置已与 Token 有效性解耦；`LXE_DATA_SERVER_ENABLED` 和旧业务 Key 仍控制尚未迁移的统计上传、MCP 等调用方。旧业务 Token 仍申请、刷新和注入，刷新失败独立显示，不能覆盖成功的 Skill 查询。

设备接入、身份迁移、模型凭据、管理员登录和 ERP 网页会话继续使用现有流程。CLI 业务执行直接接受服务器逐次鉴权，不要求先运行 cloud-context，也不接受桌面缓存作为业务授权。

本轮不修改服务器、权限模板或 Skill 类型，不生成安装包。Windows 源码验证、实际 CLI 进程桥接及开发版页面验收结果记录在交付记录中；生产验证只执行读取。
