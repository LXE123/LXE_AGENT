# Stock SKU Download Step

状态：Archive / Sanitized

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

分为 4 步，依次发送请求，最后可以拿到一个 xlsx 文件。

---

第一步
request
```HTTP
POST https://private.mabangerp.com/index.php?mod=export.doStockExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 648
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

backUrl=&orderIds=DP260317703%0D%0ADP260317702%0D%0ADP260317701%0D%0ADP260317606%0D%0ADP260317605%0D%0ADP260317604%0D%0ADP260317603%0D%0ADP260317602%0D%0ADP260317601%0D%0ADX2509032L01-L%0D%0ADX241125101%0D%0A&fieldlabel=uq101&fieldlabel=uq103&map-name%5B%5D=%E5%BA%93%E5%AD%98SKU&map-uq%5B%5D=uq101&map-text%5B%5D=&map-name%5B%5D=%E5%BA%93%E5%AD%98SKU%E4%B8%AD%E6%96%87%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq103&map-text%5B%5D=&templateName=&templateId=0&datasOpen=1&memcacheKey: <redacted>
```

response
```HTTP
HTTP/1.1 200 OK
Date: Tue, 12 May 2026 02:55:02 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 7223017b99d52cc100e7b20f9e89827a-30d094413669693c9fe7121e8f51a849
Content-Length: 104

{"success_type":2,"sn":"dd3e7c90e3f2d04f36578a6418fc0c71","subtask_num":1,"chunkNum":500,"success":true}
```

第二步
request
```HTTP
POST https://private.mabangerp.com/index.php?mod=export.doStockExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 89
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

&tableBase=&isMerage=1&version=v2&sn=dd3e7c90e3f2d04f36578a6418fc0c71&sub_no=1&step=2&1=1
```

response
```HTTP
HTTP/1.1 200 OK
Date: Tue, 12 May 2026 02:55:03 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 824d1c85e723853748c39792d4f3d58a-0b3a73131a5744f459f8f346cf488167
Content-Length: 72

{"updateR":true,"subO":[{"id":"33344293","success":"1"}],"success":true}
```

第三步
request
```HTTP
POST https://private.mabangerp.com/index.php?mod=export.doStockExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 80
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

&tableBase=&isMerage=1&sn=dd3e7c90e3f2d04f36578a6418fc0c71&version=v2&step=3&1=1
```

response
```HTTP
HTTP/1.1 200 OK
Date: Tue, 12 May 2026 02:55:03 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: c7bfb2b85e127f04fd5e8fea37ecd098-217e82f583f213418515495adc2a9649
Content-Length: 49

{"async":true,"taskId":"25674955","success":true}
```

第四步
request
```HTTP
POST https://private.mabangerp.com/index.php?mod=export.doStockExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 96
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

&tableBase=&isMerage=1&sn=dd3e7c90e3f2d04f36578a6418fc0c71&version=v2&step=4&taskId=25674955&1=1
```

response
```HTTP
HTTP/1.1 200 OK
Date: Tue, 12 May 2026 02:55:03 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: aa236ae3caff0d2cb4c3bbf8a07bfe19-0c5f41aa2ad5aa14997d663a6adfb325
Content-Length: 201

{"success":true,"file_url":"https:\/\/cos-temp.mabangerp.com\/\/excel\/\/1\/2026-05-12\/%E5%BA%93%E5%AD%98SKU%E5%AF%BC%E5%87%BA%E6%95%B0%E6%8D%AE20260512105503442706-588320355745124352.xlsx","state":1}
```


如果超出 500 个（注意官方网站说明不能超出 3000 个）
第一步会得到
```html
HTTP/1.1 200 OK
Date: Tue, 12 May 2026 03:16:02 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 75589dfeaa6d44d48f81c4070e308fc6-d85abafc7f899fe1406e4bb48de0d867
Content-Length: 104

{"success_type":2,"sn":"e4e9d8f4d8d3c4e920150acfd7f0cf19","subtask_num":6,"chunkNum":500,"success":true}
```
然后会发送 “"subtask_num":6” 次 step 2 的请求，
比如前两次
```http
POST https://private.mabangerp.com/index.php?mod=export.doStockExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 89
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

&tableBase=&isMerage=1&version=v2&sn=e4e9d8f4d8d3c4e920150acfd7f0cf19&sub_no=1&step=2&1=1
```

```http
POST https://private.mabangerp.com/index.php?mod=export.doStockExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 89
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
Accept: application/json, text/javascript, */*; q=0.01
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
sec-ch-ua-mobile: ?0
Origin: https://private.mabangerp.com
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: <redacted>

&tableBase=&isMerage=1&version=v2&sn=e4e9d8f4d8d3c4e920150acfd7f0cf19&sub_no=2&step=2&1=1
```
