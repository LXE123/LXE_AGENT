---
name: replenishment-msku-download
description: 按已解析的马帮 Amazon FBA 店铺 ID 下载该店铺 MSKU 数据 Excel。用户要求获取某个店铺、欧洲区整组或欧洲子站点的 MSKU 数据、店铺 MSKU 表、补货用 MSKU 数据时使用；如果用户只给店铺名，先使用 replenishment-store-resolve 解析 store_name、store_id 和 id_type。
type: amazon_replenish
commands:
  - lxeskill replenish msku download
---

## When to Use

- 用户要下载某个马帮 Amazon 店铺的 MSKU 数据 Excel。
- 用户已提供 `store_name`、`store_id` 和 `id_type`，需要按店铺导出 MSKU 数据。
- 用户只提供店铺名时，先用 `replenishment-store-resolve` 获取 `store_id`、`id_type`、`store_name`。

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI：`lxeskill replenish msku download`
- 不要手动拼接马帮请求。
- 不要手写、复用或转述样例 Cookie/token。
- 不要猜测店铺 ID；如果缺少 `store_name`、`store_id` 或 `id_type`，先运行 `replenishment-store-resolve`。
- `id_type` 本身就是马帮请求字段名，值只允许是 `fbaWarehouseIds[]` 或 `shopId`。
- 不要把 `shopId` 当作 `fbaWarehouseIds[]` 使用，也不要反过来使用。
- 后续流程只使用 `xlsx_path`；CLI 已把 `.xls` 转成 `.xlsx` 并删除原始 `.xls`。
- CLI 失败时只转述 terminal 的 `error.message`；需要定位阶段时可读取 `data.context`。

## Required Input

- 必须有 `store_name`、`store_id` 和 `id_type`。
- `store_name` 用于输出展示和文件命名，不允许省略。

## How to Execute

如果用户只给店铺名，先解析店铺：

```text
lxeskill replenish store resolve --store-name "<店铺名>"
```

解析成功后，使用返回的 `store_id`、`id_type`、`store_name` 下载店铺 MSKU 数据：

```text
lxeskill replenish msku download --store-id "<ID>" --id-type "<fbaWarehouseIds[]|shopId>" --store-name "<店铺名>"
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "store_id": "697456821",
  "id_type": "shopId",
  "id_count": 123,
  "xlsx_path": "artifacts/replenish/store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
  "converted": true,
  "raw_excel_deleted": true,
  "source": "mabang_store_msku_download"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "store_id": "697456821",
  "id_type": "shopId",
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户店铺 MSKU 数据已下载完成，并提供 `xlsx_path`。
- 可以简要说明 `store_name`、`store_id`、`id_type` 和 `id_count`。
- `converted=true` 表示马帮返回了 `.xls`，CLI 已转换成 `.xlsx`。
- `success=false`：只转述 `exception`。

## Active 核验与计算范围

- 单店、单站点下载后，CLI 用官方 `pStatus=["Active"]` Listing 标注源表；需要 `LXE_DATA_SERVER_URL` 和 `LXE_DATA_SERVER_API_KEY`，网页下载仍使用原来的店铺 ID 和登录态。
- 原始记录全部保留，新增“在售核验结果”“是否参与计算”“排除原因”。只有确认 Active 的行进入后续销量和库存计算；未匹配的行标为“未确认在售”，不能转述成“停售”。即使有近期销量，被排除的行也不参与计算。
- 隐藏的 `Active核验信息` Sheet 保存本轮绑定、SKU 类型、店铺站点及源数据指纹。请保留完整文件，不手动改标记或删除核验 Sheet。
- `original_row_count`、`active_row_count`、`excluded_row_count` 分别表示原始、参与、排除行数；原始数等于后两者之和。
- 欧洲多站点整组仍可下载原表，但暂不支持 Active 计算；需要计算时分别下载子站点。旧版未打标源表需重新下载。
- 命令最多执行 30 分钟，官方 Listing 阶段期限 25 分钟。进度在 stderr，等待最终 terminal；官方 API 失败不会触发 Cookie 刷新，也不会发布未核验的源表。
- 同一分钟下载若目标文件已存在，会保留已有文件并报错；下一分钟重新下载即可，不要删除历史文件来规避冲突。
