# FBA Delivery Excel API Note

状态：Archive / Sanitized

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

生请求，这个请求中的 bearer 就是 local storage 中的 https://amz1-private.mabangerp.com 中的 freeToken
```http
POST https://api-private.mabangerp.com/fba/api/v1/shippBatchDelivery/getBatchDeliveryList HTTP/1.1
Host: api-private.mabangerp.com
Connection: keep-alive
Content-Length: 64
sec-ch-ua-platform: "Windows"
Authorization: Bearer <redacted>
lang: zh
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
sec-ch-ua-mobile: ?0
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/plain, */*
Content-Type: application/json
ProjectId: erp
Origin: https://amz1-private.mabangerp.com
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Referer: https://amz1-private.mabangerp.com/
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8

{"status":"0","page":1,"prePage":20,"delivery_no":"SP260508022"}
```
response，重点是里面的 “"id":147674”
```http
HTTP/1.1 200 OK
Date: Mon, 11 May 2026 03:24:15 GMT
Content-Type: application/json
Connection: keep-alive
X-Powered-By: PHP/7.4.13
Cache-Control: private, must-revalidate
pragma: no-cache
expires: -1
X-RateLimit-Limit: 600000
X-RateLimit-Remaining: 599999
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, OPTIONS,PUT,PATCH,DELETE
Access-Control-Allow-Headers: *
Access-Control-Allow-Headers: DNT,web-token,app-token,Authorization,Accept,Origin,Keep-Alive,User-Agent,X-Mx-ReqToken,X-Data-Type,X-Auth-Token,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range
Access-Control-Expose-Headers: Content-Length,Content-Range
X-WAF-UUID: 9390c76a89d2743dceac4ea10d5bfade-f0f14ca98f600d316f4a7125c4ece758
Content-Length: 11191

{"code":200,"msg":"success","data":{"current_page":1,"data":[{"id":147674,"delivery_no":"SP260508022", ...
```

拿到 id 后，发送这个请求，请求体中，除了 ids 里的内容都是固定的
```
POST https://api-private.mabangerp.com/fba/api/v1/taskreport/push HTTP/1.1
Host: api-private.mabangerp.com
Connection: keep-alive
Content-Length: 228
sec-ch-ua-platform: "Windows"
Authorization: Bearer <redacted>
lang: zh
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
sec-ch-ua-mobile: ?0
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/plain, */*
Content-Type: application/json
ProjectId: erp
Origin: https://amz1-private.mabangerp.com
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Referer: https://amz1-private.mabangerp.com/
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8

{"reportEndDate":"2026-05-11","reportStartDate":"2026-05-11","simpleTaskConfigId":"amz-fba-batch-delivery","reportParams":{"status":"0","page":1,"prePage":20,"ids":[147674],"export_type":"1","currency_type":"1","entry_type":""}}
```
这是对应的 response，重点是 "taskId":370502
```http
HTTP/1.1 200 OK
Date: Mon, 11 May 2026 03:09:20 GMT
Content-Type: application/json
Connection: keep-alive
X-Powered-By: PHP/7.4.13
Cache-Control: private, must-revalidate
pragma: no-cache
expires: -1
X-RateLimit-Limit: 600000
X-RateLimit-Remaining: 599999
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, OPTIONS,PUT,PATCH,DELETE
Access-Control-Allow-Headers: *
Access-Control-Allow-Headers: DNT,web-token,app-token,Authorization,Accept,Origin,Keep-Alive,User-Agent,X-Mx-ReqToken,X-Data-Type,X-Auth-Token,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range
Access-Control-Expose-Headers: Content-Length,Content-Range
X-WAF-UUID: ec6d4eb81f1698ed830ab8a1b0004e38-9aaa7137efa5003f3505f63851d7511f
Content-Length: 356

{"code":200,"msg":"success","data":{"taskId":370502,"title":"fba\u62a5\u8868-\u53d1\u8d27\u5355","reportDateRange":"2026-05-11 ~ 2026-05-11","companyId":null,"operatorId":null,"operator":"\u6258\u7ba1RPA","taskType":1,"taskTypeText":"\u5bfc\u51fa","createTime":"2026-05-11 11:09:20","taskDoneTime":"-","taskStatus":0,"taskStatusText":"\u5f85\u5904\u7406"}}
```

拥有 taskID 后请求这个看看有没有在任务列表里
```http
GET https://api-private.mabangerp.com/fba/api/v1/taskreport/list?page=1&perPage=20&searchContent=&timeType=createTime&taskType=1&taskStatus=&orderByField[]=createTime&orderByType[]=desc HTTP/1.1
Host: api-private.mabangerp.com
Connection: keep-alive
sec-ch-ua-platform: "Windows"
Authorization: Bearer <redacted>
lang: zh
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
sec-ch-ua-mobile: ?0
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/plain, */*
ProjectId: erp
Origin: https://amz1-private.mabangerp.com
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Referer: https://amz1-private.mabangerp.com/
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
```

response
```http
HTTP/1.1 200 OK
Date: Mon, 11 May 2026 07:09:33 GMT
Content-Type: application/json
Connection: keep-alive
X-Powered-By: PHP/7.4.13
Cache-Control: private, must-revalidate
pragma: no-cache
expires: -1
X-RateLimit-Limit: 600000
X-RateLimit-Remaining: 599993
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, OPTIONS,PUT,PATCH,DELETE
Access-Control-Allow-Headers: *
Access-Control-Allow-Headers: DNT,web-token,app-token,Authorization,Accept,Origin,Keep-Alive,User-Agent,X-Mx-ReqToken,X-Data-Type,X-Auth-Token,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range
Access-Control-Expose-Headers: Content-Length,Content-Range
X-WAF-UUID: 5f39b82bcfd00bf1d3eb7af8ee8f7f30-7fb34df70ee8467d93b4089455608ee5
Content-Length: 5447

{"code":200,"msg":"success","data":{"total":7,"currentPage":"1","list":[{"taskId":370597,"title":"fba\u62a5\u8868-\u53d1\u8d27\u5355","companyId":900614,"task_params":"{\"status\":\"0\",\"page\":1,\"prePage\":20,\"delivery_no\":\"SP260508022\",\"ids\":[],\"export_type\":\"1\",\"currency_type\":\"1\",\"entry_type\":null}","reportDateRange":"2026-05-11 ~ 2026-05-11","createTime":"2026-05-11 15:09:26","taskDoneTime":null,"taskType":1,"taskStatus":0,"errMessage":"","operatorId":1086441,"fileHash":"","retryTimes":0,"operator":"\u6258\u7ba1RPA","reportType":"","adType":"","exportField":"","shopId":null,"exportType":"","taskStatusText":"\u5f85\u5904\u7406","taskTypeText":"\u5bfc\u51fa","retryToken":""},{"taskId":370502,"title":"fba\u62a5\u8868-\u53d1\u8d27\u5355","companyId":900614,"task_params":"{\"status\":\"0\",\"page\":1,\"prePage\":20,\"delivery_no\":\"SP260508022\",\"ids\":[],\"export_type\":\"1\",\"currency_type\":\"1\",\"entry_type\":null}","reportDateRange":"2026-05-11 ~ 2026-05-11","createTime":"2026-05-11 15:08:57","taskDoneTime":"2026-05-11 15:09:03","taskType":1,"taskStatus":2,"errMessage":"done","operatorId":1086441,"fileHash":"1e126ba3261966c8b8118b34f1a10566f4ee613e1eed6ec21b27b4c4952df53c","retryTimes":0,"operator":"\u6258\u7ba1RPA","reportType":"","adType":"","exportField":"","shopId":null,"exportType":"","taskStatusText":"\u5904\u7406\u5b8c\u6210","taskTypeText":"\u5bfc\u51fa","retryToken":""}]}}
```

如果“taskStatusText=处理完成”说明该任务可以下载了，发送下面请求，得到下载地址
req
```http
GET https://api-private.mabangerp.com/fba/api/v1/taskreport/download?taskId=370596&fileHash=1e126ba3261966c8b8118b34f1a10566f4ee613e1eed6ec21b27b4c4952df53c HTTP/1.1
Host: api-private.mabangerp.com
Connection: keep-alive
sec-ch-ua-platform: "Windows"
Authorization: Bearer <redacted>
lang: zh
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
sec-ch-ua-mobile: ?0
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/plain, */*
ProjectId: erp
Origin: https://amz1-private.mabangerp.com
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Referer: https://amz1-private.mabangerp.com/
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
```
response
```http
HTTP/1.1 200 OK
Date: Mon, 11 May 2026 07:14:51 GMT
Content-Type: application/json
Connection: keep-alive
X-Powered-By: PHP/7.4.13
Cache-Control: private, must-revalidate
pragma: no-cache
expires: -1
X-RateLimit-Limit: 600000
X-RateLimit-Remaining: 599998
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, OPTIONS,PUT,PATCH,DELETE
Access-Control-Allow-Headers: *
Access-Control-Allow-Headers: DNT,web-token,app-token,Authorization,Accept,Origin,Keep-Alive,User-Agent,X-Mx-ReqToken,X-Data-Type,X-Auth-Token,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range
Access-Control-Expose-Headers: Content-Length,Content-Range
X-WAF-UUID: 139fe4c2314c1df3262ccef135803388-f3dc258c2d797e531032711117360ef5
Content-Length: 451

{"code":200,"msg":"success","data":{"taskId":370596,"fileName":"fba\u62a5\u8868-\u53d1\u8d27\u5355_2026-05-11 ~ 2026-05-11_588021890088919040370596234216.csv","fileHash":"1e126ba3261966c8b8118b34f1a10566f4ee613e1eed6ec21b27b4c4952df53c","downloadUrl":"https:\/\/fba-1253885479.cos.ap-guangzhou.myqcloud.com\/UPLOAD_V3\/900614\/2026-05\/fba%E6%8A%A5%E8%A1%A8-%E5%8F%91%E8%B4%A7%E5%8D%95_2026-05-11%20~%202026-05-11_588021890088919040370596234216.csv"}}
```
