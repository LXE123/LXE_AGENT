---
name: replenishment-algorithm-config-manage
description: 管理马帮 Amazon 备货算法参数方案。用户要求查看备货公式参数、导出备货算法配置表给业务人员修改、校验配置表xlsx、导入/保存自定义参数方案、查看已有参数方案或准备用某套算法参数计算备货时使用。
type: amazon_replenish
commands:
  - lxeskill replenish template
---

# 管理备货算法参数方案

## 执行与错误

- 通过 `exec` 调用本 Skill 声明的 CLI；不手工拼 API、不猜 ID 或凭据、不直接执行 Python 业务模块。
- 只把最后一条 `type="result"` 当作 terminal：先看 `ok`，业务字段读 `data`，附件读 `files`；失败保留 `error.message` 和相关 `data.context`，不把业务示例当成完整 terminal。
- 命令返回运行中/session running 时等待同一会话，不重复启动下载或导出。
- 只有 `data.auth_refresh_required=true` 才按 `lxeskill auth refresh` 的恢复流程刷新一次，再重试失败步骤；为 false 或缺失时停止并保留诊断，不凭错误文本中的 401/403 或 ID 猜测认证失败。
- 店铺歧义展示真实候选供选择；绑定冲突、分页异常、数据服务权限错误停止。文件占用时提示关闭对应文件后重试，不删除目标。
- 业务执行中不修改安装目录脚本、依赖或历史报表绕过错误；用户另行要求源码修复时按开发任务处理。
- 完整备货任务按 `replenishment-workflow-map` 连续推进；单步请求只执行指定步骤，缺前置数据时说明缺什么及下一步，不自行扩展为完整备货。
- 单步文件任务成功后调用 `send_files(paths=<terminal.files>)`；完整任务的中间文件保留，到最终计算完成才发送最终 terminal `files`。没有附件时不猜路径。发送成功才说已交付，发送失败只重试交付，不重跑业务。

## 命令与流程

```text
lxeskill replenish template list
lxeskill replenish template list-params
lxeskill replenish template show --template "<方案名>"
lxeskill replenish template export --template "<方案名>"
lxeskill replenish template validate-file --xlsx "<用户修改的配置表>"
lxeskill replenish template import --xlsx "<配置表>" [--name "<新方案名>"]
lxeskill replenish template replace --template "<已有自定义方案名>" --xlsx "<配置表>"
lxeskill replenish template rename --template "<旧名称>" --name "<新名称>"
```

- 新建/修改方案：导出供用户编辑，用户返回后先 validate-file，通过后按其意图 import 或 replace。发送导出 terminal files，不把内部方案库当附件。
- 用 list/show 判断方案是否存在及系统方案限制，不硬编码全部方案名称。“默认”和其他系统方案不能覆盖或重命名。
- 用户只要求查看/管理参数时不自动计算；要求用该方案完成备货时保留方案名并交给完整流程。

## 规则与错误

- 配置表只是编辑介质，正式计算读取方案库。不得手改 JSON；只通过 CLI 管理。
- 方案管理权重、销量门槛、天数、运输方式、海运/同时空运拆分及特殊 MSKU 规则，不管理库存扣减。
- 海运重量门槛已取消，缺重量不阻断海运；旧 `sea.min_weight_kg` 忽略，仅含旧重量字段的兼容配置仍允许导入。
- 校验失败保留实际错误。只有错误明确说明结构不兼容才重新导出；参数值非法就指出具体参数，不套用“旧版不支持”的固定话术。
- 黄色单元格是可编辑输入，灰色说明不参与导入；天数正整数、日销区间等规则以 list-params 和校验结果为准。
