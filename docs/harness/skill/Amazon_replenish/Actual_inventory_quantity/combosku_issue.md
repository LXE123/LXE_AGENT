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
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
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
Cookie: lang=cn; mabang_lite_rowsPerPage=100; route=585503fea6c564b44e6a79bd986e57d1; stock_sort_cook=; MSKU_LIST_ROWSPERPAGE_1086441=100; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; signed=1086441_2e3a3815261252675896750ed349940a; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1780021191; Hm_lpvt_b888e3a9116ee926400397d5e2c3792b=1780021191; HMACCOUNT=7ADE3D1D8AB12373; __bid_n=19e7187e1b09648823570d; sajssdk_2015_cross_new_user=1; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219e7187e259d5b-0ca4228e02f3258-26061151-2073600-19e7187e25a10dd%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%22%24latest_traffic_source_type%22%3A%22%E7%9B%B4%E6%8E%A5%E6%B5%81%E9%87%8F%22%2C%22%24latest_search_keyword%22%3A%22%E6%9C%AA%E5%8F%96%E5%88%B0%E5%80%BC_%E7%9B%B4%E6%8E%A5%E6%89%93%E5%BC%80%22%2C%22%24latest_referrer%22%3A%22%22%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTllNzE4N2UyNTlkNWItMGNhNDIyOGUwMmYzMjU4LTI2MDYxMTUxLTIwNzM2MDAtMTllNzE4N2UyNWExMGRkIn0%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219e7187e259d5b-0ca4228e02f3258-26061151-2073600-19e7187e25a10dd%22%7D; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; PHPSESSID=drog8skco66es55ofh3ovb9mc2; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=K1WDvsXpEcCuQ5U6gGd3eX8YZs8tkfP06vt3%2Bzygl7iGU9c%2FCfYcy%2BxQbV9MhUfnmrXX8HfWKiLzWcdCdUOd4w3zKPB1JGTGuMF3sMYFVGQ%3D

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
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Origin: null
Content-Type: application/x-www-form-urlencoded
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: navigate
Sec-Fetch-User: ?1
Sec-Fetch-Dest: document
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; login_js_cookie_phone_cookie=; CustomitemsPurchaseflag=1; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1780021191; Hm_lpvt_b888e3a9116ee926400397d5e2c3792b=1780021191; HMACCOUNT=7ADE3D1D8AB12373; __bid_n=19e7187e1b09648823570d; sajssdk_2015_cross_new_user=1; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219e7187e259d5b-0ca4228e02f3258-26061151-2073600-19e7187e25a10dd%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%22%24latest_traffic_source_type%22%3A%22%E7%9B%B4%E6%8E%A5%E6%B5%81%E9%87%8F%22%2C%22%24latest_search_keyword%22%3A%22%E6%9C%AA%E5%8F%96%E5%88%B0%E5%80%BC_%E7%9B%B4%E6%8E%A5%E6%89%93%E5%BC%80%22%2C%22%24latest_referrer%22%3A%22%22%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTllNzE4N2UyNTlkNWItMGNhNDIyOGUwMmYzMjU4LTI2MDYxMTUxLTIwNzM2MDAtMTllNzE4N2UyNWExMGRkIn0%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219e7187e259d5b-0ca4228e02f3258-26061151-2073600-19e7187e25a10dd%22%7D; PHPSESSID=8e2lgkammsanv45pujna1agoj4; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=Dttw76rg4fc9lj2SpuYhUz9keb7j0D1u4J614CMavUmsOAkLDnAMD8b%2FRYBeIJwxKQLPiBDLRT3di8Gay9JRR05FmWhwnsTTYdRgGjiyY4Rei8dgtjv%2Fvcmtd6TGwDtjt%2Bky403LsQ%2FhgpOd4oUjzQ%3D%3D; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; ce=B13BWGc7sFhFoPnJl8iEVG6aCjfSzLbOfHRGj1QsojM%3D; exportv2=1

mod=export.exportTemplate&data=DX250620101-DX250604101%0D%0ADX250618210-DX250618213-2&type=1&menu=combosku&exportUrl=https%3A%2F%2Fprivate.mabangerp.com%2Findex.php%3Fmod%3Dcombosku.doExportFileNew&sessid=&showRmbColumn=2
```