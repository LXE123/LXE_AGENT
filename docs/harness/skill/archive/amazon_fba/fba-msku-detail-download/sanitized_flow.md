# MSKU Excel Download Flow

状态：Archive / Sanitized

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

发票填写 skill 

首先第一步，下载 msku 的详细数据。
msku 从哪来呢？从发货单文件里来。
在发货单中的第一个 sheet 的第一行中找到 MSKU，MSKU 这一列收集起来，然后发送下面的请求，就可以得到 msku 的详细数据的 excel 文件下载地址。

分为两个请求
第一个，获取 id
```http
POST https://private-amz.mabangerp.com/index.php?mod=fbanew.listsearch HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
Content-Length: 1002
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

shopId=&status=1&ispair=&isChange=1&amazonsite=&stockStatus=&stockStatusAmz=&developerId=&saleId=&setdataflag=&searchtexttype=platformSkuLike&Orderby=&highsearch=&atn=list&searchtext=&searchtype=4&selecttype=platformSkuIn&platformSkuData=HSPJPMZH235%0D%0ADS2307142L04HSPJPD058%0D%0AHSPJPZH302%0D%0AHSPJPZH475%0D%0AHSPJPZH478%0D%0AHSPJPZH491%0D%0AHSPJPZH494%0D%0AHSPJPZH471%0D%0ADP260410HWA01%0D%0AHSPJPZH473%0D%0ADP260410HWA02%0D%0AHSPJPZH476%0D%0AHSPJPZH495%0D%0ADP260423W1WHW05%0D%0ADP260410HWA09%0D%0AHSPJPZH303%0D%0AHSPJPZH496%0D%0ALYQ0116GCP02XYWWT3217%0D%0ADP260410HWA08%0D%0ADP260410HWA06%0D%0ADP260410HWA03%0D%0ADP260410HWA07%0D%0ADP260410HWA04%0D%0ADP260410HWA05%0D%0ADP260423W1WHW04%0D%0ADP260423W1WHW01%0D%0AHSPJPMZH236%0D%0ADX2208161L02XYWWT1289%0D%0AHSPJPZH493%0D%0AHSPJPZH472%0D%0AHSPJPZH474%0D%0ADP260423W1WHW06%0D%0AHSPJPMZH225%0D%0AHSPJPZH477%0D%0AHSPJPMZH004%0D%0AHSPJPMZH211%0D%0AHSPJPMZH009%0D%0ADP260423W1WHW03%0D%0AHSPJPMZH216%0D%0ADX2406222S01HSPJPM020%0D%0ADP260423W1WHW02%0D%0A
```
响应
```http
HTTP/1.1 200 OK
Date: Sat, 16 May 2026 10:05:26 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
X-Powered-By: PHP/5.4.45
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: b3a4d33e4376ed87e9a3d641782acc8c-ab2b1067b9394701fe84fa293fd832b8
Content-Length: 422

{"success":true,"id":"745115,745116,745117,745118,745119,745120,745121,745122,745123,745585,745586,745587,745588,745589,745590,662529,585932,692694,696601,696606,704460,704465,704474,704484,704485,666869,666870,679416,685948,679417,685949,679418,685950,679419,685951,679420,685952,679421,685953,679422,685954,679423,685955,684783,685956,685940,685957,685941,685958,685942,685959,685943,685960,631297,631306,633067,633072"}
```
第二个请求，根据 id 获取具体数据
```http
POST https://private.mabangerp.com/index.php?mod=export.doFbaExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 1764
sec-ch-ua-platform: "Windows"
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<redacted-version> Safari/537.36
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
Cookie: <redacted>

backUrl=&orderIds=631562%0D%0A631567%0D%0A634683%0D%0A634430%0D%0A634412%0D%0A634684%0D%0A634431%0D%0A634685%0D%0A634432%0D%0A634686%0D%0A634433%0D%0A634415%0D%0A634687%0D%0A634434%0D%0A634416%0D%0A634688%0D%0A634435%0D%0A634417%0D%0A634689%0D%0A634436%0D%0A634690%0D%0A634437%0D%0A634691%0D%0A634438%0D%0A634692%0D%0A634439%0D%0A634693%0D%0A634440%0D%0A634694%0D%0A634441%0D%0A634423%0D%0A634695%0D%0A634442%0D%0A634696%0D%0A634443%0D%0A634697%0D%0A634698%0D%0A634427%0D%0A634699%0D%0A634428%0D%0A634700%0D%0A634447%0D%0A635043%0D%0A635045%0D%0A635046%0D%0A635050%0D%0A635051%0D%0A635053%0D%0A634701%0D%0A634702&fieldlabel=uq101&fieldlabel=uq102&fieldlabel=uq181&fieldlabel=uq165&fieldlabel=uq103&fieldlabel=uq104&fieldlabel=uq194&fieldlabel=uq105&fieldlabel=uq141&fieldlabel=uq164&map-name%5B%5D=%E5%BA%97%E9%93%BA%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq101&map-text%5B%5D=&map-name%5B%5D=MSKU&map-uq%5B%5D=uq102&map-text%5B%5D=&map-name%5B%5D=%E5%9B%BE%E7%89%87%E9%93%BE%E6%8E%A5&map-uq%5B%5D=uq181&map-text%5B%5D=&map-name%5B%5D=%E6%9C%AC%E5%9C%B0SKU&map-uq%5B%5D=uq103&map-text%5B%5D=&map-name%5B%5D=%E7%88%B6ASIN&map-uq%5B%5D=uq194&map-text%5B%5D=&map-name%5B%5D=ASIN&map-uq%5B%5D=uq105&map-text%5B%5D=&map-name%5B%5D=%E6%9C%AC%E5%9C%B0SKU%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq141&map-text%5B%5D=&map-name%5B%5D=%E5%94%AE%E4%BB%B7&map-uq%5B%5D=uq164&map-text%5B%5D=&map-name%5B%5D=%E4%BA%A7%E5%93%81%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq104&map-text%5B%5D=&map-name%5B%5D=%E5%95%86%E5%93%81%E9%93%BE%E6%8E%A5&map-uq%5B%5D=uq165&map-text%5B%5D=&templateName=&templateId=1045273&datasOpen=2&memcacheKey: <redacted>
```
返回结果
```http
HTTP/1.1 200 OK
Date: Mon, 18 May 2026 03:49:25 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: <redacted>
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: bbff6fea7ef48e27248259c443fdb32e-922ece14b085dc2c10c2884a4b7cc558
Content-Length: 122

{"success":true,"gourl":"https:\/\/upload.mabangerp.com\/stock\/orderexport\/1086441BZGHA00qXgO177907616493662400464.xls"}
```

---

下载好的 xlsx 文件只有一个sheet，第一行只会有以下“字段”
```xlsx
店铺名称	MSKU	图片链接	本地SKU	父ASIN	ASIN	本地SKU名称	售价	产品名称	商品链接
```

接下来我们还有进行一些额外处理，不同店铺的 msku 是重复的，所以存在下载到重复 msku 的可能性。
可以通过对比店铺名称来解决这个问题。
店铺名称可以从发货单中获取，找到第一行里的`店铺`，这个就是店铺名称。
和发货单里店铺名称不一致的，新建一个 sheet 放置
