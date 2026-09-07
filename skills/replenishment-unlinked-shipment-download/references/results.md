# 未关联货件返回参考

以下为成功 terminal 的形状（省略非关键统计）；所有状态必须由本次真实查询取得。

```json
{"type":"result","ok":true,"data":{"success":true,"store_name":"Amazon-Test","status_results":[{"status_name":"WMS待配货","total":0},{"status_name":"WMS待装箱","total":0},{"status_name":"待关联货件","total":0}],"snapshot":{"success":true,"confirmed_empty":true,"snapshot_xlsx_path":"<CLI返回的真实路径>","raw_file_count":0,"detail_count":0,"msku_count":0,"total_unlinked_quantity":0}},"files":["<CLI返回的真实路径>"]}
```

非零查询的 snapshot.confirmed_empty=false，raw_file_count、detail_count、msku_count 和 total_unlinked_quantity 反映本轮输入。不要根据数量之和为零推断查询已经完整成功。

新下载链路快照带隐藏“未关联货件核验信息”：版本、规范店铺名、查询店铺 ID、download_time、snapshot_time、三个 status_totals、confirmed_empty。汇总和明细沿用原业务列。

查询或快照失败时 terminal.ok=false，实际原因读 error.message；data.download_result 若存在，表示已取得原生下载结果，尚未完成快照。完整任务停止，不回退旧快照。
