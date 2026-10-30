---
name: feishu-stock-lists-sync
description: 从飞书下载并处理东南亚和巴西备货清单，保存到指定目录。
type: replenishment
commands:
  - lxeskill feishu stock-lists sync
---

# 飞书备货清单同步

任务需要在执行机器上配置 `STOCK_SYNC_FEISHU_APP_ID`、`STOCK_SYNC_FEISHU_APP_SECRET` 和 `STOCK_SYNC_FEISHU_FOLDER_TOKEN` 环境变量，并确保启动 LXE Agent 的进程能继承它们。变量值由管理员通过安全方式配置，不放进对话或命令参数；这些变量与飞书消息网关的配置相互独立。确认用户指定的保存目录及覆盖授权后执行：

```text
lxeskill feishu stock-lists sync --destination "<保存目录>" --workers 1
```

默认单线程；每个文件下载及处理通过校验后替换同名文件。脚本使用目标目录锁防止重叠运行；进程还在运行时等待原进程，不再启动另一个同步。进程退出后根据结果的 `ok`、`data.success`、`data.files` 和 `data.log` 报告实际结果；失败文件保留原文件，不能把旧文件算作本轮成功。同步在执行 LXE Agent 的机器上运行，目标目录也属于该机器。
