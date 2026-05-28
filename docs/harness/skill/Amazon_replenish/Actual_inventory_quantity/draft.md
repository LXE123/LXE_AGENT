接下来获取真实库存

为什么要获取真实库存呢？因为我们计算备货数量时，还要顺便看看某个具体的 msku 数量有多少，不够的话就需要备注一下。

---

直接进入正题，怎么获取呢？

是这样的，我们根据店铺 id 获取的 msku 数据 excel 文件中。

有一列是`本地sku`数据。 

这个`本地sku`就是这次 skill 的主角之一。

我们要拿这个 `本地sku` 去做什么呢？总共有 4 个步骤。

1. 查找 `组合 sku`。查看哪些 `本地sku` 是 `组合 sku`，并且查看这些 `组合 sku` 由什么 `库存 sku` 构成，这些 `库存 sku` 分别又有几个。但是具体怎么查看哪些 `本地sku` 是 `组合 sku`呢？把这些 `本地sku` 都发送请求去获取一个 `组合sku` 的 excel，出现在这个 excel 里的 `本地sku` 就是 `组合 sku`。（为了避免 `本地sku` 中确实有 `组合 sku` 但是马帮服务器返回的 excel 为空，我准备了这个 `HSP022`，每次发送请求都要带上这个 `HSP022`，如果仍然返回空 excel 说明出问题了，报错。

这个组合 sku 的 excel 文件中的 sheet 的表格格式如下（注意`关联sku编号`和`关联sku捆绑数量`的数量取决于`关联sku个数`）：
```xlsx
组合sku编码	关联sku个数	关联sku编号1	关联sku捆绑数量1	关联sku编号2	关联sku捆绑数量2	关联sku编号3	关联sku捆绑数量3
DX251210110-DX251210111-17	2	DX251210111	1	DX251210110	1		
ZH599-1	10	DX0210819S07Q	1	DX0210819S06Q	1	DX0210819S11Q	1
```

请求如下，需要 4 步才能拿到 excel 文件，
```HTTP
POST https://private.mabangerp.com/index.php?mod=combosku.doExportFileNew HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 611
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; login_js_cookie_phone_cookie=; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; order_rows_per_page_data_cookie=100; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; order_data_js_cookie_get_custom_item=1; CustomitemsPurchaseflag=1; PHPSESSID=5ihu56ssm1pa9md2h6gha465m3; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; ce=B13BWGc7sFhFoPnJl8iEVG6aCjfSzLbOfHRGj1QsojM%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=Dttw76rg4fc9lj2SpuYhU2bvocp0Ptq56GS4ttT3DeMGS3C5wtU%2FIzq6Ajnx0PVNCLOE7evGGssSb2fTfXKF7d4q38ivD546O4z7cq4OxM26l2Cr8E9r6C0kZz%2BOh0y8; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjpudWxsLCJzZXJ2ZXJOYW1lIjoicHJpdmF0ZS5tYWJhbmdlcnAuY29tIn0%3D; exportv2=1

backUrl=&orderIds=DX251210110-DX251210111-17%0D%0AZH599-1%0D%0A&fieldlabel=uq101&fieldlabel=uq136&fieldlabel=uq138&map-name%5B%5D=%E7%BB%84%E5%90%88sku%E7%BC%96%E7%A0%81&map-uq%5B%5D=uq101&map-text%5B%5D=&map-name%5B%5D=%E5%85%B3%E8%81%94sku%E4%B8%AA%E6%95%B0&map-uq%5B%5D=uq136&map-text%5B%5D=&map-name%5B%5D=%E5%85%B3%E8%81%94sku%E4%BF%A1%E6%81%AF&map-uq%5B%5D=uq138&map-text%5B%5D=&templateName=&templateId=0&datasOpen=1&memcacheKey=4d056461ff480631977657c53909f93d&showRmbColumn=2&pageSave=1&operateType=19&params=&InterfaceUrl=&mainMenu=&hiddenPage=1&hiddenPageSize=&tableBase=&isMerage=1&version=v2&step=1
```
响应如下
```http
HTTP/1.1 200 OK
Date: Tue, 26 May 2026 08:55:40 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: lang=cn; expires=Thu, 25-Jun-2026 08:55:40 GMT
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 524c728c490df3b180b4809fddeb046c-577d2187eef7c3bdb5dee97d6b8f8784
Content-Length: 106

{"success_type":2,"sn":"9c41ab62f0eed4c8feb929870a49ec0b","subtask_num":1,"chunkNum":10000,"success":true}
```
第二步请求如下
```http
POST https://private.mabangerp.com/index.php?mod=combosku.doExportFileNew HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 89
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; login_js_cookie_phone_cookie=; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; order_rows_per_page_data_cookie=100; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; order_data_js_cookie_get_custom_item=1; CustomitemsPurchaseflag=1; PHPSESSID=5ihu56ssm1pa9md2h6gha465m3; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; ce=B13BWGc7sFhFoPnJl8iEVG6aCjfSzLbOfHRGj1QsojM%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=Dttw76rg4fc9lj2SpuYhU2bvocp0Ptq56GS4ttT3DeMGS3C5wtU%2FIzq6Ajnx0PVNCLOE7evGGssSb2fTfXKF7d4q38ivD546O4z7cq4OxM26l2Cr8E9r6C0kZz%2BOh0y8; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjpudWxsLCJzZXJ2ZXJOYW1lIjoicHJpdmF0ZS5tYWJhbmdlcnAuY29tIn0%3D; exportv2=1

&tableBase=&isMerage=1&version=v2&sn=9c41ab62f0eed4c8feb929870a49ec0b&sub_no=1&step=2&1=1
```
响应
```http
HTTP/1.1 200 OK
Date: Tue, 26 May 2026 08:55:41 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: lang=cn; expires=Thu, 25-Jun-2026 08:55:40 GMT
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: cfeec1bfc72b33a22617fedfd51749a3-365e0f84949a894fe27e0f7982d7026b
Content-Length: 72

{"updateR":true,"subO":[{"id":"34233123","success":"1"}],"success":true}
```
第三步请求
```http
POST https://private.mabangerp.com/index.php?mod=combosku.doExportFileNew HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 80
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; login_js_cookie_phone_cookie=; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; order_rows_per_page_data_cookie=100; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; order_data_js_cookie_get_custom_item=1; CustomitemsPurchaseflag=1; PHPSESSID=5ihu56ssm1pa9md2h6gha465m3; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; ce=B13BWGc7sFhFoPnJl8iEVG6aCjfSzLbOfHRGj1QsojM%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=Dttw76rg4fc9lj2SpuYhU2bvocp0Ptq56GS4ttT3DeMGS3C5wtU%2FIzq6Ajnx0PVNCLOE7evGGssSb2fTfXKF7d4q38ivD546O4z7cq4OxM26l2Cr8E9r6C0kZz%2BOh0y8; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjpudWxsLCJzZXJ2ZXJOYW1lIjoicHJpdmF0ZS5tYWJhbmdlcnAuY29tIn0%3D; exportv2=1

&tableBase=&isMerage=1&sn=9c41ab62f0eed4c8feb929870a49ec0b&version=v2&step=3&1=1
```
响应
```http
HTTP/1.1 200 OK
Date: Tue, 26 May 2026 08:55:41 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: lang=cn; expires=Thu, 25-Jun-2026 08:55:41 GMT
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 922904deae6ddf6aed93c5096d462349-8086746cb97bcb8adf24d72abd8b5ebe
Content-Length: 49

{"async":true,"taskId":"26157694","success":true}
```

第四步请求
```http
POST https://private.mabangerp.com/index.php?mod=combosku.doExportFileNew HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 96
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; login_js_cookie_phone_cookie=; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; order_rows_per_page_data_cookie=100; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; order_data_js_cookie_get_custom_item=1; CustomitemsPurchaseflag=1; PHPSESSID=5ihu56ssm1pa9md2h6gha465m3; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; ce=B13BWGc7sFhFoPnJl8iEVG6aCjfSzLbOfHRGj1QsojM%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=Dttw76rg4fc9lj2SpuYhU2bvocp0Ptq56GS4ttT3DeMGS3C5wtU%2FIzq6Ajnx0PVNCLOE7evGGssSb2fTfXKF7d4q38ivD546O4z7cq4OxM26l2Cr8E9r6C0kZz%2BOh0y8; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjpudWxsLCJzZXJ2ZXJOYW1lIjoicHJpdmF0ZS5tYWJhbmdlcnAuY29tIn0%3D; exportv2=1

&tableBase=&isMerage=1&sn=9c41ab62f0eed4c8feb929870a49ec0b&version=v2&step=4&taskId=26157694&1=1
```
响应
```http
HTTP/1.1 200 OK
Date: Tue, 26 May 2026 08:55:41 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: lang=cn; expires=Thu, 25-Jun-2026 08:55:41 GMT
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 799f6a716bc61c4ea095bb743ee29543-1b72ef1516fb29096d21e6dbcb8981d0
Content-Length: 202

{"success":true,"file_url":"https:\/\/cos-temp.mabangerp.com\/\/excel\/\/1\/2026-05-26\/%E7%BB%84%E5%90%88SKU%E5%AF%BC%E5%87%BA%E6%95%B0%E6%8D%AE-20260526165541318375-593484541363736576.xlsx","state":1}
```

2. 知道哪些  `本地sku` 是 `组合 sku` 后，剩下的就全是 `库存 sku` 了。查询这些 `库存 sku` 的真实库存数量（那些 `组合sku` 中的 `库存sku`也要跟着查）。
拿到 excel 文件后，sheet 表格的格式如下
```xlsx
库存SKU编号	商品状态	活跃度	是否新款	一级目录	二级目录	三级目录	一级品牌	二级品牌	采购员	中文名称	英文名称	父级仓库	仓库	仓位	销量(7/28/42)	预测日销量(个)	仓位库存	当前可售天数	在途量	海外仓预调入量	分仓调拨预调入量	警戒量	警戒天数	未发货量	分仓调拨未发货	可用库存量	在途货值(RMB)	成本价(RMB)	总价值(RMB)	最后出库时间	最后入库时间	商品备注
```
比较简单，查看 `库存SKU编号` 对应的 `可用库存量` 就是该库存 sku 的真实库存。
查询请求如下，分两步
第一步：
```http
POST https://private-amz.mabangerp.com/index.php?mod=warehouse.searchwarehousestock HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
Content-Length: 541
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
Cookie: lang=cn; mabang_lite_rowsPerPage=100; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; signed=1086441_2e3a3815261252675896750ed349940a; route=585503fea6c564b44e6a79bd986e57d1; stock_sort_cook=; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; PHPSESSID=531d4gkjf42dbbbq09hs86c6n4; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=K1WDvsXpEcCuQ5U6gGd3eX8YZs8tkfP06vt3%2Bzygl7iGU9c%2FCfYcy%2BxQbV9MhUfnmrXX8HfWKiLzWcdCdUOd4w3zKPB1JGTGuMF3sMYFVGQ%3D; MSKU_LIST_ROWSPERPAGE_1086441=100

stockOrderby=&parentCategoryId=&categoryId=&third_category_id=&warehouseIds%5B%5D=1014318&stockName=nameCN&stockNameValue=&statusIN%5B%5D=3&inventoryAlertId=0&livenessType=&isNewType=&gridcodeStr=&stockSkuStr=DP210426L19%0D%0ADP210426L23%0D%0ADP210426L22%0D%0ADP210426L21%0D%0ADP210426L20%0D%0ADP210426L24%0D%0ADP021019CL09%0D%0A&page=1&rowsPerPage=50&warehouseId=undefined&startTime=&endTime=&isIdn=1&warehouseIdArr=&stockQuantitylt=&stockQuantitygt=&stockWarningQuantitylt=&stockWarningQuantitygt=&saleAvailableDayslt=&saleAvailableDaysgt=
```
第二步请求：
```http
GET https://private-amz.mabangerp.com/index.php?mod=warehouse.doexportwarehousestock&flag=1&showRmbColumn=0 HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"
Upgrade-Insecure-Requests: 1
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: navigate
Sec-Fetch-User: ?1
Sec-Fetch-Dest: document
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; mabang_lite_rowsPerPage=100; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; signed=1086441_2e3a3815261252675896750ed349940a; route=585503fea6c564b44e6a79bd986e57d1; stock_sort_cook=; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; PHPSESSID=531d4gkjf42dbbbq09hs86c6n4; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=K1WDvsXpEcCuQ5U6gGd3eX8YZs8tkfP06vt3%2Bzygl7iGU9c%2FCfYcy%2BxQbV9MhUfnmrXX8HfWKiLzWcdCdUOd4w3zKPB1JGTGuMF3sMYFVGQ%3D; MSKU_LIST_ROWSPERPAGE_1086441=100
If-Modified-Since: Wed, 27 May 2026 02:29:10 GMT
```
响应直接是 excel 文件，所以只截取部分
```http
HTTP/1.1 200 OK
Date: Wed, 27 May 2026 02:33:24 GMT
Content-Type: application/force-download
Connection: keep-alive
X-Powered-By: PHP/5.4.45
Set-Cookie: lang=cn; expires=Fri, 26-Jun-2026 02:33:24 GMT
Set-Cookie: warehouseStockExportPage_1086441=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT
Content-Disposition: attachment;filename="1779849204.xlsx"
Expires: Mon, 26 Jul 1997 05:00:00 GMT
Last-Modified: Wed, 27 May 2026 02:33:24 GMT
Cache-Control: cache, must-revalidate
Pragma: public
X-WAF-UUID: af278456c534aa5b6c6bfcf08953c6ae-1493d36b6308b3078744ae9538343d22
Content-Length: 8154

PK    ,T \G D X        [Content_Types].
```
3. 得到所有 `库存sku` 的库存数量后，就可以计算 `组合sku` 的库存数量了。
怎么计算：假设有一个 combo_Sku 由一个 Stock_sku_A（库存数量为 10）和两个 Stock_sku_B（库存数量为 12）和三个 Stock_sku_C（库存数量为 15）组成。那么这个 combo_sku 的真实库存数量应该就是为 5。

4. 计算好后把真实库存写入一个新的 xlsx。
mksu 父ASIN 子ASIN 本地sku 库存数量
如果是`组合sku`还要加上一个字段 `子sku`，具体内容就是该`组合sku`包含哪些`库存sku`大概是这样 `stock_sku_A * 1, stock_sku_B * 5, stock_sku_C * 3`


---


流程跑通了，接下来还需要做一些优化。

第一个优化，根据情况给最终的真实库存 excel 分 sheet。 
- 根据店铺 id 获取的 msku 数据中，不是所有的 msku 都有对应的 本地sku。
这些 msku 不用查询，然后写入最终的真实库存 excel 时，新写一个 sheet，放置这些无本地 sku 的 msku。
- 有 本地sku 数据的，也会出现一种情况，没有库存数据。这是因为查询库存时，请求头的 payload 指定了只查询在正常销售的 sku。所以把这些无库存数量数据的 msku 也单独放一个 sheet 表格

第二个优化，把真实库存 sheet 拆成 `真实库存-组合sku` 和 `真实库存-库存sku`。
`真实库存-组合sku` 是组合sku的放这个 sheet。其余的放到`真实库存-库存sku` 。
还要给这两个sheet 增加三列，一列是加权日销，一列是可销售天数，一列是`FBA总库存`，这三列新的放在 `商品链接` 这一列之后。
加权日销 = 7天销量 / 7 * 0.6 + 14天销量 / 14 * 0.3 + 30天销量 / 30 * 0.1
可销售天数 = FBA总库存/加权日销
FBA总库存 = 可售 + 待入库 + 预留 + 在途

记得按加权日销排序（降序）