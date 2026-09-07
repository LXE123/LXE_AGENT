---
name: replenishment-amazon-restock-inventory-snapshot
description: 将用户从 Seller Central 手动下载的亚马逊补充库存 CSV 解析为备货可用的亚马逊补充库存 snapshot。用户要求使用亚马逊补充库存、解析补充库存 CSV、校验补充库存文件是否对应店铺、询问亚马逊库存报告怎么下载/哪里下载/下载路径/截图指引，或在备货建议中增加亚马逊补充库存扣减字段时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish inventory restock-snapshot-build
references:
  - references/download-and-validation.md
---

# 亚马逊补充库存对照快照

## 执行与错误

- 通过 `exec` 调用本 Skill 声明的 CLI；不手工拼 API、不猜 ID 或凭据、不直接执行 Python 业务模块。
- 只把最后一条 `type="result"` 当作 terminal：先看 `ok`，业务字段读 `data`，附件读 `files`；失败保留 `error.message` 和相关 `data.context`，不把业务示例当成完整 terminal。
- 命令返回运行中/session running 时等待同一会话，不重复启动下载或导出。
- 只有 `data.auth_refresh_required=true` 才按 `lxeskill auth refresh` 的恢复流程刷新一次，再重试失败步骤；为 false 或缺失时停止并保留诊断，不凭错误文本中的 401/403 或 ID 猜测认证失败。
- 店铺歧义展示真实候选供选择；绑定冲突、分页异常、数据服务权限错误停止。文件占用时提示关闭对应文件后重试，不删除目标。
- 业务执行中不修改安装目录脚本、依赖或历史报表绕过错误；用户另行要求源码修复时按开发任务处理。
- 完整备货任务按 `replenishment-workflow-map` 连续推进；单步请求只执行指定步骤，缺前置数据时说明缺什么及下一步，不自行扩展为完整备货。
- 单步文件任务成功后调用 `send_files(paths=<terminal.files>)`；完整任务的中间文件保留，到最终计算完成才发送最终 terminal `files`。没有附件时不猜路径。发送成功才说已交付，发送失败只重试交付，不重跑业务。

## 使用与命令

只有用户明确要求 Amazon 侧库存对照时启用；输入为用户从 Seller Central 手动下载的 CSV。本 Skill 不登录或自动下载 Seller Central 数据，不替换主流程马帮库存口径。

```text
lxeskill replenish inventory restock-snapshot-build --store-name "<规范店铺名>" --csv "<CSV路径>"
```

用户明确指定马帮源表时附加 `--msku-xlsx "<源表路径>"`。名称不确定先读店铺解析 Skill；缺源表按当前完整/单步范围处理。

## 校验与结果

- CSV 必须有 Merchant SKU、Total Units。CLI 校验店铺匹配率和库存分项；失败保留实际错误，不因字段相似自行转换。
- `Amazon.Found.*` 作为真实 MSKU 参与快照校验，不按名称排除；这不改变主计算只使用 Active 行的范围。
- 成功保留 `data.snapshot_xlsx_path` 和核验摘要；用户要求用于计算时传 `--amazon-restock-inventory-snapshot`，增加对照字段，不重复扣减主建议。
- 单步任务交付 terminal files；完整任务保留对照快照路径到最终计算。
- 用户询问下载入口、截图或详细分项校验时读 [references/download-and-validation.md](references/download-and-validation.md)，使用已有截图资产，不猜路径。
