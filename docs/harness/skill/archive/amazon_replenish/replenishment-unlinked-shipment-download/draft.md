# Unlinked Shipment Lookup Draft

状态：Archive / Draft

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

## 执行顺序

1. 确认 Chrome/马帮登录态可用。
2. 按店铺名下载三类未关联货件原生文件：`WMS待配货`、`WMS待装箱`、`待关联货件`。
3. 用下载到的 raw 文件生成未关联货件 snapshot。
4. 备货计算时传入 `--unlinked-shipments-snapshot`。

## 固定 CLI

下载未关联货件原生文件：

```bash
uv run --frozen python -m services.agent_cli.mabang.download_store_unlinked_shipments --store-name "<店铺名>"
```

生成未关联货件 snapshot：

```bash
uv run --frozen python -m services.agent_cli.mabang.build_store_unlinked_shipments_snapshot --store-name "<店铺名>" --raw-file "<raw_file_path>"
```

如果一个店铺下载出多个 raw 文件，重复传多个 `--raw-file`：

```bash
uv run --frozen python -m services.agent_cli.mabang.build_store_unlinked_shipments_snapshot --store-name "<店铺名>" --raw-file "<raw_file_path_1>" --raw-file "<raw_file_path_2>"
```

备货计算接入 snapshot：

```bash
uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>" --template "<模板名>" --unlinked-shipments-snapshot "<snapshot_xlsx_path>"
```

原生文件目录：

```text
artifacts/mabang_fba_unlinked_shipments/
```

快照目录：

```text
artifacts/mabang_fba_unlinked_shipments_snapshots/
```

## 请求明细

### 1. 店铺解析

```http
GET https://api-private.mabangerp.com/fba/api/v1/shop/shopCountry?warehouse=1
```

用输入店铺名精确匹配 `data.shop[].name`，取匹配项的 `id` 作为店铺 ID。

### 2. 三个状态查总数

```http
POST https://api-private.mabangerp.com/fba/api/v1/shippBatchDelivery/getBatchDeliveryList
```

`WMS待配货` payload：

```json
{
  "status": 6,
  "is_batch_create": 1,
  "delivery_type": 2,
  "store": [697476809],
  "page": 1,
  "prePage": 1
}
```

`WMS待装箱` payload：

```json
{
  "status": 9,
  "is_batch_create": 1,
  "store": [697476809],
  "page": 1,
  "prePage": 1
}
```

`待关联货件` payload：

```json
{
  "status": 10,
  "is_batch_create": 1,
  "store": [697476809],
  "page": 1,
  "prePage": 1
}
```

`total = 0` 时不创建导出任务；`total > 0` 时创建导出任务。

### 3. 创建导出任务

```http
POST https://api-private.mabangerp.com/fba/api/v1/taskreport/push
```

payload 示例：

```json
{
  "reportEndDate": "2026-06-13",
  "reportStartDate": "2026-06-13",
  "simpleTaskConfigId": "amz-fba-batch-delivery",
  "reportParams": {
    "status": 9,
    "is_batch_create": 1,
    "store": [697476809],
    "page": 1,
    "prePage": 20,
    "ids": [],
    "export_type": "1",
    "currency_type": "1",
    "entry_type": ""
  }
}
```

`WMS待配货` 的 `reportParams` 额外包含：

```json
{
  "delivery_type": 2
}
```

### 4. 轮询任务中心

```http
GET https://api-private.mabangerp.com/fba/api/v1/taskreport/list?page=1&perPage=20&searchContent=&timeType=createTime&taskType=1&taskStatus=&orderByField[]=createTime&orderByType[]=desc
```

轮询频次：

```text
创建任务后立即查一次。
未完成则每 10 秒查一次。
默认超时 180 秒。
```

完成判断：

```text
taskStatus == 2
或 taskStatusText == "处理完成"
```

等待判断：

```text
taskStatus in {0, 1}
或 taskStatusText in {"待处理", "处理中", "排队中", "生成中", "执行中"}
```

失败判断：

```text
非完成、非等待状态直接失败。
```

### 5. 获取下载地址

```http
GET https://api-private.mabangerp.com/fba/api/v1/taskreport/download?taskId=<taskId>&fileHash=<fileHash>
```

读取返回值：

```text
data.downloadUrl
data.fileName
data.fileHash
```

然后对 `data.downloadUrl` 发 GET，下载原生文件二进制并保存到：

```text
artifacts/mabang_fba_unlinked_shipments/
```

文件名格式：

```text
<download_time>-<店铺名>-<状态名>-<taskId>.<后缀>
```

## 结果读取

只读取 CLI 输出的最后一行 JSON。

下载成功示例：

```json
{
  "success": true,
  "store_name": "Amazon-xxx-US",
  "store_id": 697476809,
  "download_time": "202606131730",
  "status_results": [
    {
      "status_name": "WMS待配货",
      "total": 0,
      "task_id": null,
      "file_hash": "",
      "file_name": "",
      "raw_file_path": ""
    },
    {
      "status_name": "WMS待装箱",
      "total": 3,
      "task_id": 370502,
      "file_hash": "xxx",
      "file_name": "fba报表-发货单.csv",
      "raw_file_path": "artifacts/mabang_fba_unlinked_shipments/202606131730-Amazon-xxx-US-WMS待装箱-370502.csv"
    }
  ],
  "source": "mabang_fba_unlinked_shipments"
}
```

snapshot 成功示例：

```json
{
  "success": true,
  "store_name": "Amazon-xxx-US",
  "snapshot_time": "202606131735",
  "snapshot_xlsx_path": "artifacts/mabang_fba_unlinked_shipments_snapshots/202606131735-Amazon-xxx-US_unlinked_shipments_snapshot.xlsx",
  "raw_file_count": 2,
  "detail_count": 100,
  "msku_count": 80,
  "total_unlinked_quantity": 1200,
  "source": "mabang_fba_unlinked_shipments_snapshot"
}
```

失败示例：

```json
{
  "success": false,
  "store_name": "Amazon-xxx-US",
  "exception": "未找到店铺..."
}
```

## 操作规则

- 不手写马帮请求，固定使用 CLI。
- 不展示或复用 token/cookie；CLI 内部复用马帮鉴权。
- 店铺名错误时，只转述 `exception`，按候选店铺名重试。
- `total = 0` 是正常结果，不算失败。
- 导出任务未完成时不要重复启动同一个下载命令。
