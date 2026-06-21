# Actual Inventory Combo SKU Issue

状态：Archive / Sanitized

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

获取组合 SKU 的流程是：

1. 从最新店铺 MSKU 文件里读取所有非空 `本地SKU`。
2. 请求组合 SKU 导出时，额外追加哨兵 SKU：`HSP022`。
   作用是防止马帮返回空表时误判为“没有组合 SKU”。如果导出的组合 SKU 表里没有 `HSP022`，就报错。
3. 调马帮组合 SKU 导出接口：
   `POST https://private.mabangerp.com/index.php?mod=combosku.doExportFileNew`
4. 导出分 4 步：
   - `step=1`：提交本地 SKU 列表，返回 `sn`、`subtask_num`
   - `step=2`：按 `sub_no` 执行子任务
   - `step=3`：提交 `sn`，返回 `taskId`
   - `step=4`：用 `sn + taskId` 获取 `file_url`
5. 下载 `file_url` 得到组合 SKU xlsx。
6. 解析 xlsx：
   - `组合sku编码`
   - `关联sku个数`
   - `关联sku编号1 / 关联sku捆绑数量1`
   - `关联sku编号2 / 关联sku捆绑数量2`
   - 后续 N 组同理

---

这里有一个问题，获取组合 SKU 文件时，会有不稳定的情况，我的想法是发送正式的获取组合sku文件请求前，也就是第三步前，先发送下面两个正常操作时必会发送的两个请求。不用关心返回什么，发送第一个，等一秒，然后发送第二个就行。

同样追加哨兵组合 sku

第一个
```http
POST https://private-amz.mabangerp.com/index.php?mod=combosku.getCombosSkuList HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
Content-Length: 211
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private-amz.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

searchLike=comboSku&operate=Like&searchKeywords=&labelId=&timeStart=&timeEnd=&searchStatus=&isBatchSearch=1&selecttype=comboSku&stockData=DX250620101-DX250604101%0D%0ADX250618210-DX250618213-2&page=&rowsPerPage=
```

第二个
```http
POST https://private.mabangerp.com/index.php HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 221
Cache-Control: max-age=0
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"
Upgrade-Insecure-Requests: 1
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Origin: null
Content-Type: application/x-www-form-urlencoded
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: navigate
Sec-Fetch-User: ?1
Sec-Fetch-Dest: document
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

mod=export.exportTemplate&data=DX250620101-DX250604101%0D%0ADX250618210-DX250618213-2&type=1&menu=combosku&exportUrl=https%3A%2F%2Fprivate.mabangerp.com%2Findex.php%3Fmod%3Dcombosku.doExportFileNew&sessid=&showRmbColumn=2
```
