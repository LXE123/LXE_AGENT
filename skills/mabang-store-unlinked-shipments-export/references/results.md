# 未关联货件返回参考

以下是省略非关键字段的终态示例。店铺、数量、错误和路径均用于说明结构，不能当成本次查询结果；`<…>` 路径不可用于工具调用。

## 混合状态：部分有数据、部分为零

```json
{
  "type": "result",
  "ok": true,
  "data": {
    "success": true,
    "store_name": "Amazon-Test-US",
    "status_results": [
      {"status_name": "WMS待配货", "total": 5, "raw_file_path": "<本次待配货原生CSV路径>"},
      {"status_name": "WMS待装箱", "total": 2, "raw_file_path": "<本次待装箱原生CSV路径>"},
      {"status_name": "待关联货件", "total": 0, "raw_file_path": ""}
    ],
    "snapshot": {
      "success": true,
      "confirmed_empty": false,
      "snapshot_xlsx_path": "<本次快照XLSX路径>",
      "raw_file_count": 2,
      "detail_count": 134,
      "msku_count": 113,
      "total_unlinked_quantity": 13835
    }
  },
  "files": ["<本次待配货原生CSV路径>", "<本次待装箱原生CSV路径>", "<本次快照XLSX路径>"]
}
```

此例是 7 张发货单、134 条商品明细、113 个 MSKU、13,835 件商品，四者不可混用。“待关联货件”为 0 不影响另外两个状态的导出与快照生成。

单步任务发送 `files` 成功后可回复：

> Amazon-Test-US 查询完成：待配货 5 张、待装箱 2 张、待关联 0 张。已交付 2 份原始文件和扣减快照，包含 113 个 MSKU、13,835 件商品，可用于本轮备货计算。

完整任务继续计算，不以这段回复结束整轮备货。

## 三个状态均为零

```json
{
  "type": "result",
  "ok": true,
  "data": {
    "success": true,
    "store_name": "Amazon-Test-US",
    "status_results": [
      {"status_name": "WMS待配货", "total": 0},
      {"status_name": "WMS待装箱", "total": 0},
      {"status_name": "待关联货件", "total": 0}
    ],
    "snapshot": {
      "success": true,
      "confirmed_empty": true,
      "snapshot_xlsx_path": "<本次确认零货件的快照路径>",
      "raw_file_count": 0,
      "detail_count": 0,
      "msku_count": 0,
      "total_unlinked_quantity": 0
    }
  },
  "files": ["<本次确认零货件的快照路径>"]
}
```

没有原始文件是正常结果，快照仍有效；单步交付这份快照，完整任务使用它继续计算。不要把“没有 CSV”解释为“没有取得快照”。

## 原始文件已下载，快照生成失败

```json
{
  "type": "result",
  "ok": false,
  "data": {
    "success": false,
    "store_name": "Amazon-Test-US",
    "exception": "<实际快照生成异常>",
    "download_result": {
      "success": true,
      "store_name": "Amazon-Test-US",
      "status_results": [
        {"status_name": "WMS待配货", "total": 5, "raw_file_path": "<已下载待配货CSV路径>"},
        {"status_name": "WMS待装箱", "total": 2, "raw_file_path": "<已下载待装箱CSV路径>"},
        {"status_name": "待关联货件", "total": 0, "raw_file_path": ""}
      ]
    }
  },
  "files": [],
  "error": {"code": "business_cli_failed", "message": "<实际快照生成异常>"}
}
```

此时可确认两份原始文件已下载，但没有可用于正式计算的快照。保留下载结果与实际错误；不能因为内层 `download_result.success=true` 宣称整条命令成功。当前失败终态不会将这些文件列为交付附件，不把内层路径冒充 `files`。

若查询或下载阶段失败，可能只有 `data.exception`、`error.message`，没有 `download_result`。仅从已有日志说明进度，不能据此声称“所有状态都失败”或“没有生成任何文件”。

## 快照核验信息

快照的业务 Sheet 为“未关联货件汇总”和“未关联货件明细”。确认零货件时只保留业务表头，不伪造商品行。

隐藏的“未关联货件核验信息”记录版本、规范店铺名、店铺 ID、`download_time`、`snapshot_time`、三个 `status_totals` 和 `confirmed_empty`。这些内容由 CLI 生成和核验，模型无需例行打开检查，也不能删除或改写来绕过核验。
