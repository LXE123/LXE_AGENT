# 桌面云端接入、凭据与权限

本文说明 Electron 如何发现公司设备、同步云端权限与模型，以及打开 ERP 和管理后台。Agent 的文件写入模式与单次提权属于另一套 [执行权限](../harness/runtime/permission-policy.md)；云端授予某项业务能力不会扩大 Tool 的本地写入范围。

## 接入与自动发现

电脑已连接公司 WireGuard 时，安装版、源码开发和预览目录都可自动识别设备，无需每个目录重复导入接入包。未配置接入信息时使用公司默认地址；已接入目录使用自己的服务器地址；切换绑定期间暂停查询和地址注入。地址选择以 [company-server.ts](../../apps/desktop/src/main/company-server.ts) 为准。

建立或更换受管连接仍需接入包：v5 用于受管 WireGuard，v4 用于已有手工隧道或更换凭据。Windows 通过 UAC 安装或复用隧道，关闭桌面不卸载系统隧道；macOS 源码环境见 [WireGuard 服务](macos-wireguard-service.md)。旧身份的恢复流程见 [身份迁移](identity-migration.md)。

自动识别不会伪造接入配置、激活本目录或自动开启统计上传、赛狐 MCP。统计启用仍由本目录接入配置决定；MCP 有自己的开关。各目录分别保存配置和缓存，不复制聊天、工作区、实例 ID 或上传进度。

## 调用链与职责

| 能力 | 当前调用链 | 结果由谁使用 |
| --- | --- | --- |
| 设备和权限发现 | Electron → `lxeskill cloud-context` → `GET /api/v1/device-context` | Electron 缓存并展示；将 Skill 范围同步给 agentcli |
| 公司模型目录与管理角色 | Electron Main → `GET /api/v1/device-access` | Main 同步模型目录、管理角色和版本 |
| 公司模型凭据 | Main → `GET /api/v1/device-access/llm-credential` | Main 按模型领取并交给 Agent 模型调用链 |
| ERP／管理后台登录 | Main → `POST /api/v1/device-access/browser-handoff` | 外部浏览器兑换一次性交接码 |
| 业务 API | lxeskillCLI 自行请求服务器 | CLI 处理业务结果，服务器逐次鉴权 |
| 统计与赛狐 MCP | agentcli 分别通过自己的上传服务和 MCP 连接访问服务器 | 见 [统计上传](../harness/runtime/native-statistics-upload.md)与 [赛狐 MCP](../saihu-device-access.md) |

这些原生公司请求使用 `X-LXE-Client: cli`，不携带旧业务 Token、Authorization 或 Cookie，不使用系统代理，不跟随重定向。该请求头是公开标记，设备身份由服务器根据实际 WireGuard 来源识别。接入包激活、身份检查和旧身份迁移仍有独立的凭据流程，不能把两条链路混为一谈。

`cloud-context` 的 CLI 输出和诊断契约见 [CLI 云端通信](../lxeskill-cli/cloud-access.md#权限查询与连接自检)。`device-context` 只返回权限，不返回模型密钥；模型凭据不经 CLI stdout 或 Renderer。

## 权限刷新与缓存

启动、手动刷新、约每 60 秒轮询和系统唤醒时检查云端。同轮请求合并；停止或切换设备时取消在途查询，拒绝旧身份的迟到结果。一次权限查询成功后继续同步模型和管理角色；旧 identity 响应不再更新在线 Skill 授权或公司模型状态。

服务器返回四类授权：`skill_types` 决定 Skill 范围，`desktop_features` 决定桌面入口，`server_capabilities` 与 `erp_actions` 表示业务服务与 ERP 动作。模板名称不会在本地扩展成新权限；业务服务器在实际请求时再次鉴权，不以桌面缓存代替授权判断。Skill 范围通过既有通道热更新，不因此重启 Gateway。

权限面板展示设备、授权和验证时间；未知标识原样显示，尚未取得的授权与已经验证的空授权分别展示。缓存和失败诊断明确标记，不把旧缓存显示成刚验证成功。

| 情况 | 处理 |
| --- | --- |
| 首次识别 | 接受结构合法的设备及权限响应 |
| 已有接入配置 | 核对设备 ID、WireGuard 地址；冲突时通过接入切换流程处理 |
| 仅有自动识别记录，身份变化 | 清空旧权限和模型缓存，等待确认；确认时重新查询并核对新身份 |
| 断网、超时、服务器临时错误 | 保留已验证缓存，显示错误和最近验证时间，不申请新的网页会话 |
| 权限查询返回 401／403 或身份不匹配 | 清除权限和模型缓存；已识别身份记录保留 |
| 模型访问返回 401／403 | 清除公司模型缓存并标记拒绝；业务入口的专项拒绝按各自错误处理 |
| 服务器返回收权或空授权 | 直接应用，不叠加旧范围 |
| 版本倒退、同版本内容变化、无效 CLI 输出 | 拒绝新数据并保留诊断；不回退旧授权接口 |

权限快照记录设备归属、分配版本和模板版本。旧缓存兼容与类型改名见 [权限兼容与迁移](permission-migration.md)。刷新权限本身不安装或重连 WireGuard；页面上的重连操作单独处理隧道。

## 模型与网页登录

公司模型缓存绑定服务器和设备身份。模型下架或凭据版本改变时，先删除失效凭据再领取替代；普通临时故障保留仍有效的缓存，单个模型的普通领取失败不清空其他模型。设备拒绝和身份变化按前表处理。个人模型配置和选择保留；目录和模型参数规则见 [公司模型目录](../harness/llm/provider_catalog.md)。清除本目录模型缓存不撤销服务器权限，保持连接时下一次刷新可以重新领取。

管理角色来自 `device-access` 的 `management_role`，不能从设备名称、设备类型或 Skill 范围推导。ERP 按钮先检查 `desktop_features`，然后申请 `target=erp` 的交接码；管理后台使用 `target=admin`。两者都通过设备鉴权申请，不使用本地根身份凭据。服务器分别校验管理角色和 ERP 业务权限，某个入口拒绝不会被解释成另一类权限也已撤销。

交接码通过浏览器 URL fragment 交给对应网页兑换，不传递设备根凭据或模型 Key。服务端交接码只能使用一次、60 秒有效；网页使用独立 Cookie 会话，最长 8 小时、空闲 30 分钟过期，并执行同源、CSRF 和后续请求的权限检查。失效后从桌面重新进入。

服务器缺少新版接口时显示升级提示，不回退旧凭据登录。模型仍使用已下发的供应商 API Key；停用设备可阻止再次领取，不能保证供应商立即撤销已领取 Key，也不会撤回已发出的模型请求。

## 凭据与本地存储

数据目录及 `safeStorage`、个人模型 Key 的保存方式见 [桌面配置](README.md#桌面配置与安全)。这里区分用途，不另维护一套存储规则。

| 数据 | 用途与边界 |
| --- | --- |
| `data_server_api_key` | 历史字段名，当前保存设备身份凭据，用于接入激活、身份检查和迁移；只由 Main 使用，不注入 Agent／CLI，也不再用于新版模型与网页登录 |
| `cloud_identity_candidate` | 持久保存的待迁移身份，确认完成前不替换当前身份 |
| `cloud_observed_device`、`cloud_permission_snapshot` | 自动识别身份与已验证权限缓存；不是一份伪造的 Enrollment |
| `managed_llm_state`、`managed_llm_owner` | 公司模型凭据和归属，供模型调用链使用，不作为通用业务 Token |
| 旧业务 Token、ERP／赛狐专用 Key | 已退出桌面申请、刷新和环境注入；旧加密文件中的废弃字段忽略，后续保存不再写回 |

旧模型缓存只有在原接入信息能确认归属时迁移，否则清除后重新领取；个人模型凭据保留。历史凭据方案见 [早期身份方案](../record/20260910-client-identity-v1.md)和 [业务 Token 清理记录](../record/20260922-client-business-token-cleanup.md)。

## 维护与验证入口

服务端需先具备对应原生接口和会话来源迁移（`0039_native_browser_sessions`），再更新客户端。旧身份、权限类型的升级和回退按各自迁移手册处理；是否已部署必须核实实际环境，不能从历史验收推断。

- [desktop-cloud.ts](../../apps/desktop/src/main/desktop-cloud.ts)、[cloud-permissions.ts](../../apps/desktop/src/main/cloud-permissions.ts)：权限同步、身份连续性、缓存和版本校验。
- [native-cloud-access.ts](../../apps/desktop/src/main/native-cloud-access.ts)、[native-cloud-client.ts](../../apps/desktop/src/main/native-cloud-client.ts)：模型凭据、网页交接与原生 HTTP；[cloud-context.ts](../../apps/desktop/src/main/cloud-context.ts)：CLI 进程桥接。
- [桌面云端测试](../../apps/desktop/test/desktop-cloud.test.ts)、[自动访问测试](../../apps/desktop/test/native-cloud-access.test.ts)、[CLI 桥接测试](../../apps/desktop/test/cloud-context.test.ts)：按改动范围选用。
- 隔离页面验收：`bun scripts/device-context-acceptance.ts` 与 `bun scripts/native-cloud-acceptance.ts`。使用临时配置、本地模拟服务、实际 CLI 和 Electron 组件；截图默认位于系统临时目录，不代替完整桌面或 Windows 真机联调。

历次测试结果和当时未完成事项见 [云端接入验收](../acceptance/cloud-access-20260922-20261005.md)与 [凭据和权限迁移验收](../acceptance/cloud-migrations-20260922.md)。
