---
name: replenishment-store-resolve
description: 解析马帮 Amazon 店铺名称、网页查询 ID 和真实候选。用于备货前确认店铺、查询店铺 ID 或处理模糊名称；解析结果可能为整组，下载时仍须限定单站点。
type: amazon_replenish
commands:
  - lxeskill replenish store resolve
---

# 解析马帮店铺

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

用户给模糊店铺名、需要网页下载 ID 或查看候选时使用；这里不是紫鸟店铺 ID。

```text
lxeskill replenish store resolve --store-name "<店铺名>"
lxeskill replenish store resolve
```

省略店铺名时列出全部店铺，不代表已选择店铺。

## 结果与下一步

- 成功且有 `data.store_id`：保留 `store_name`、`store_id`、`id_type`，完整任务继续下载 MSKU。
- `id_type` 是网页请求字段，仅有 `fbaWarehouseIds[]`、`shopId` 两种。二者不能混用；`fbaWarehouseIds[]` 也可能属于单站点，不能据此认定多站点整组。
- 网页下载 ID 不等于官方 Listing 的 sid，后者由 CLI 解析，不由模型转换。
- 解析旧名称时使用 CLI 返回的规范结果，不删除名称里的国家文字来猜别名。
- 失败有 `data.candidates`：展示候选供用户选择，不自动选第一个；候选文件从 terminal files 交付。
- 成功列出全部店铺时交付文件，简述数量，不把列表成功当作目标店铺匹配成功。
- 多站点范围最终由 MSKU 下载入口依据真实父子关系判断；整组不能进入下载与备货。
