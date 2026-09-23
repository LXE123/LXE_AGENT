# 智汇 TMS 菲律宾阶段 6 交接：Desktop 安全配置

## 已实现

- Desktop 设置增加“智汇 TMS”集成：账号、密码和独立的生产 API 开关。
- 账号与生产开关存入普通设置；密码按现有 Desktop 安全存储机制写入加密 `secrets.bin`。界面和 Setup State 只显示密码是否已配置。
- 开关默认关闭。仅当账号、密码齐全且开关启用，运行时环境才提供 `ZHIHUI_TMS_ACCOUNT`、`ZHIHUI_TMS_PASSWORD` 和 `ZHIHUI_TMS_PRODUCTION_ENABLED=1`；其余情况下账号密码为空且开关为 `0`。
- 清除集成时删除存储密码并关闭生产调用。空白密码补丁保留既有安全存储密码。
- IPC 对账号、密码长度和生产开关类型进行校验；中英文界面均有明确的生产 API 说明。
- Desktop 保存配置后会依据运行环境变化重启 Gateway，使新的受控环境进入 CLI 子进程。

## 验证

- Desktop 配置、IPC、Dashboard 设置、Gateway 开发环境定向测试：`57 pass`。
- Desktop、Dashboard、Gateway、desktop-protocol 的 TypeScript 类型检查通过。
- 未使用真实智汇账号，未调用生产 API。

## 后续验收

- 需要在可用的 Desktop 上做自然语言预览、显式执行、进度、错误和多个附件的联调。
- 真实 API 的登录响应、下载域名、Cookie、MIME 和风控策略仍需经人工确认后进行一次低频验收；在此之前不能宣称生产端到端完成。
