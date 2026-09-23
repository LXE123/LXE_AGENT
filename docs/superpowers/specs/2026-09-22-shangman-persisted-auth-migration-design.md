# 上马持久化认证迁移设计

## 目标

以 `upstream/main` 的 `Credentials`、`AuthStore` 与 `GoodsExporter` 作为上马认证权威，同时保留当前 feature 的固定 `上马印尼 / 印尼 / goods_export` 业务 Contract、单文件交付和紧凑 terminal projection。

## 边界

- 有效 token 的导出只读取持久化状态，不获取验证码、不创建人工输入等待。
- 无 token、过期 token 或凭据指纹变化时，exporter 返回 `login_required`，并且不发 ERP export 请求。
- ERP export 的 401 只使当前旧 token 失效，并返回 `login_required`；底层不重试提交导出。
- 独立 `shangman-login` 负责 prepare/submit/status/clear。登录完成后最多恢复原 export 一次是 `shangman-goods-export` Skill/Agent Contract；由于两个命令都是 `session_mode: none`，本期不新增跨回合 Runtime 硬限制。
- feature 保留 `LXE_SHANGMAN_PROD_ENABLED`，且在读取 token 或创建 exporter 前拦截。
- 删除 feature 的 `pending_sensitive_input` Shangman capability、Broker 等待、`captcha_channel`、challenge 跨 run 恢复及每次 export 的人工通道检查。

## 不变项

- 不修改 Runtime Step Loop、公共 `business.py`、其他平台 Contract、上马 ERP HTTP 风控策略或下载/工作簿校验策略。
- 模型可见商品任务始终只有固定 `goods_export` 业务意图；登录是认证恢复能力，不新增第二套商品意图。
- terminal data 保持平台、国家、业务类型、行数和已脱敏错误的最小集合。
