这个 SKILL 的分类为 Amazon_replenish

---

这个 skill 的过程大概是这样的，用户说，我要 xx 店铺的 msku 数据，然后就会有脚本发送请求，最后拿到一个关于 msku 的 excel 文件的下载地址，下载下来后就结束了。

---

但这里有一个问题是店铺名挺多的，似乎需要专门写一个 skill 来处理店铺名问题？

先来看看如何获取相关店铺的名称和 ID 吧。
发送下面这个请求
```http
GET https://private-amz.mabangerp.com/index.php?mod=fbanew.list&platform=amazon&version=1&cMKey=4d056461ff480631977657c53909f93d&fromTest=111&lang=cn&tz=UTC+8&DOMAIN=private.mabangerp.com HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
sec-ch-ua: "Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"
Upgrade-Insecure-Requests: 1
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7
Sec-Fetch-Site: same-site
Sec-Fetch-Mode: navigate
Sec-Fetch-Dest: iframe
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: zh-CN,zh;q=0.9,zh-TW;q=0.8
Cookie: lang=cn; mabang_lite_rowsPerPage=100; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; signed=1086441_2e3a3815261252675896750ed349940a; route=7e2255998080824457b93008cd36e6e4; stock_sort_cook=; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; PHPSESSID=24c149m4fsa19a9df3ggeurku4; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=jzr5Fxn%2FPj0LQY0DrEaprDEn9nWeE%2BuS92RiPLrn77vM9h%2Bs%2F8YzT%2BJMPijUSEX3C5E%2FcnMDgB30N4vyU0VdAby1x%2Bwm9RcyWGugJFygqAw%3D
```
响应是一个 html 文件夹，这里我就先不贴出来了，但是我可以告诉你如何解析出店铺名和 ID
用下面的代码
```py
input_tag = li.find("input", attrs={"name": "fbaWarehouseIds[]"})
text_span = li.find("span", class_="texts")
warehouse_id = input_tag.get("value")
clean_name = text_span.get_text().strip()
store_map[clean_name] = str(warehouse_id)
```
就可以拿到。

OK先写一个专门获取店铺名和ID的 skill 吧
---
好的测试后发现，有一部分店铺没读取到，这里放出一部分 html 来参考如何读取
```html
<li class="">                 
                        <label class="checkbox-inline">
                            <input name="fbaWarehouseIds[]" onclick="$('.listShopDiv .dropdown-toggle .text').html('店铺');$('#listform input[name=shopId]').val('')" value="1024109" type="checkbox">
                            <span class="texts">Amazon-Liansheng-BR                                                        </span>
                        </label>
                                            </li>
                    <li class="dropdown-submenu">
                        <label class="checkbox-inline">
                            <input name="fbaWarehouseIds[]" onclick="$('.listShopDiv .dropdown-toggle .text').html('店铺');$('#listform input[name=shopId]').val('')" value="1014510" type="checkbox">
                            <span class="texts">Amazon-区                                                            <i class="ico-arrow-right3 fsize16 fr text-default" style="margin-top: 2px;"></i>
                                                        </span>
                        </label>
                                                    <ul class="dropdown-menu" style="width:220px;">
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697618612" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697618612')">Amazon-Lerxiuer-SE</a></li>
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697618611" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697618611')">Amazon-Lerxiuer-PL</a></li>
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697456824" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697456824')">Amazon-Lerxiuer-NL</a></li>
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697456823" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697456823')">Amazon-lerxiuer-ES</a></li>
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697456822" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697456822')">Amazon-Lerxiuer-IT</a></li>
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697456821" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697456821')">Amazon-Lerxiuer-FR</a></li>
                                                                <li><a data-type="shopId" href="javascript:void(0);" data-val="697456820" onclick="$('.listShopCount').html(0);$('#listform').find('input[name=\'fbaWarehouseIds[]\']').attr('checked',false);$('#listform input[name=shopId]').val('697456820')">Amazon-Lerxiuer-DE</a></li>
                                                            </ul>
                                            </li>
                
                    <li class="">

                        
                        <label class="checkbox-inline">
                            <input name="fbaWarehouseIds[]" onclick="$('.listShopDiv .dropdown-toggle .text').html('店铺');$('#listform input[name=shopId]').val('')" value="1023854" type="checkbox">
                            <span class="texts">Amazon-lerxiuer-BR                                                        </span>
                        </label>
                                            </li>
                
                    <li class="">
```
可以看到，有时候会多出一个 <ul class="dropdown-menu" style="width:220px;">，里面还有一些额外的店铺名称和店铺 id（id是这个“data-val="697618612"” data-val）。
为什么会多出来这些呢？
因为欧洲区的店铺马帮支持一起查询和单个站点查询。
比如这个例子中，用`Amazon-区`去查询，可以查询到很多所有欧洲站点的 msku，也可以选择其中某个站点，查询这个站点的 msku。
---
查询到的店铺 ID 有两种类型，分成 fba_warehouse_id 和 shop_id
---
好的，继续往下讨论，修改后，一次查出 149 个店铺，我的想法是，不应该把详细的数据都写到脚本的返回结果里，当查询全部店铺时应该，生成一个xlsx文件把这些数据装进去。
已变成返回 xlsx 文件作为结果，模糊查询时，10 个以上才会变成 xlsx

---

接下来一个新 skill，根据店铺下载msku数据。那么下一步就是怎么用这个获取好的店铺 id 去查询 msku 了

大概要发两个请求，
第一个请求`获取 ids`有两种请求方式：
第一种 fba_warehouse_id
请求： 
```HTTP
POST https://private-amz.mabangerp.com/index.php?mod=fbanew.listsearch HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
Content-Length: 268
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
Cookie: lang=cn; mabang_lite_rowsPerPage=100; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; signed=1086441_2e3a3815261252675896750ed349940a; route=7e2255998080824457b93008cd36e6e4; stock_sort_cook=; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; PHPSESSID=24c149m4fsa19a9df3ggeurku4; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=jzr5Fxn%2FPj0LQY0DrEaprDEn9nWeE%2BuS92RiPLrn77vM9h%2Bs%2F8YzT%2BJMPijUSEX3C5E%2FcnMDgB30N4vyU0VdAby1x%2Bwm9RcyWGugJFygqAw%3D

fbaWarehouseIds%5B%5D=1039477&shopId=&status=1&ispair=&isChange=1&amazonsite=&stockStatus=&stockStatusAmz=&developerId=&saleId=&setdataflag=&searchtexttype=platformSkuLike&Orderby=&highsearch=&atn=list&searchtext=&searchtype=4&selecttype=platformSkuIn&platformSkuData=
```

第二种 shop_id
```http
POST https://private-amz.mabangerp.com/index.php?mod=fbanew.listsearch HTTP/1.1
Host: private-amz.mabangerp.com
Connection: keep-alive
Content-Length: 247
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
Cookie: lang=cn; mabang_lite_rowsPerPage=100; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; signed=1086441_2e3a3815261252675896750ed349940a; route=7e2255998080824457b93008cd36e6e4; stock_sort_cook=; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; PHPSESSID=24c149m4fsa19a9df3ggeurku4; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=jzr5Fxn%2FPj0LQY0DrEaprDEn9nWeE%2BuS92RiPLrn77vM9h%2Bs%2F8YzT%2BJMPijUSEX3C5E%2FcnMDgB30N4vyU0VdAby1x%2Bwm9RcyWGugJFygqAw%3D

shopId=697456821&status=1&ispair=&isChange=1&amazonsite=&stockStatus=&stockStatusAmz=&developerId=&saleId=&setdataflag=&searchtexttype=platformSkuLike&Orderby=&highsearch=&atn=list&searchtext=&searchtype=4&selecttype=platformSkuIn&platformSkuData=
```
幸运的是，返回体都是一样的
```http
HTTP/1.1 200 OK
Date: Thu, 21 May 2026 08:58:09 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
X-Powered-By: PHP/5.4.45
Set-Cookie: lang=cn; expires=Sat, 20-Jun-2026 08:58:09 GMT
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: db68ef904cd5479b87dddd86637bdf31-ef8d284cd5d6898e76beb98a30be11ee
Content-Length: 9998

{"success":true,"id":"683425,618589,618590,618591,618592,618593,618594,618595,618596,618597,618599,..."}
```

拿到这些 id 后怎么办呢，发送这个请求
```http
POST https://private.mabangerp.com/index.php?mod=export.doFbaExportFile HTTP/1.1
Host: private.mabangerp.com
Connection: keep-alive
Content-Length: 30930
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
Cookie: lang=cn; login_js_cookie_phone_cookie=; __bid_n=19c4bf8e1df4032e6f4ec0; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWMzOTVhMjc5NWMtMDFiOTZhNjczZTI4MDg3LTI2MDYxYzUxLTIwNzM2MDAtMTljYWMzOTVhMjg3MGYifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%2219cac395a2795c-01b96a673e28087-26061c51-2073600-19cac395a2870f%22%7D; order_rows_per_page_data_cookie=100; Hm_lvt_016d02857372dbbcabf56ce5f43fd3ae=1776492767; Hm_lvt_b888e3a9116ee926400397d5e2c3792b=1777338528; MULTI_LANGUAGE_TYPE=%2BYjZ6oacL7xJ%2FKOcmBg9Z7cTOqi7UgOUgujRs4KQ4Ms%3D; order_data_js_cookie_get_custom_item=1; CustomitemsPurchaseflag=1; print_picking_key_cookie=number%2Cwarehouse%2CnameCN%2CstockRemark%2CquantityInterval%2ConPassage%2C; PHPSESSID=65en58qrfot0id9ijsupkrifl1; MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE=4d056461ff480631977657c53909f93d; MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS=Dttw76rg4fc9lj2SpuYhUz9keb7j0D1u4J614CMavUkWrHgWHYpDiIS0lES9YvntI2AFT%2FEzW75SgGR3LrPGcHHT7PzdpxRH01DYRzoNrD7cJEZcLIe3hEtr0ZFs%2B4C7HI4Qc1B8UfQOFKc1F0Cc%2Fg%3D%3D; MABANG_ERP_PRO_UNIQUE_ID=eyJlbXBsb3llZUlkIjoiMTA4NjQ0MSIsInNlcnZlck5hbWUiOiJwcml2YXRlLm1hYmFuZ2VycC5jb20ifQ%3D%3D; ce=B13BWGc7sFhFoPnJl8iEVG6aCjfSzLbOfHRGj1QsojM%3D; CRAWL_KANDENG_KEY=sgt2Zr6nRib5zN2DfU2yDtunXzrH0rnf7CDd%2FGtH9P8REjrdXfa6aYMbl6xEZWHi3m%2FWBycXeMFZH8JxCOIvMA%3D%3D; exportv2=2

backUrl=&orderIds=719829%0D%0A719830%0D%0A719831%0D%0A719832%0D%0A616892&fieldlabel=uq101&fieldlabel=uq102&fieldlabel=uq165&fieldlabel=uq154&fieldlabel=uq103&fieldlabel=uq104&fieldlabel=uq194&fieldlabel=uq105&fieldlabel=uq106&fieldlabel=uq107&fieldlabel=uq108&fieldlabel=uq109&fieldlabel=uq110&fieldlabel=uq114&fieldlabel=uq118&fieldlabel=uq119&fieldlabel=uq172&fieldlabel=uq173&fieldlabel=uq120&fieldlabel=uq122&fieldlabel=uq124&fieldlabel=uq125&fieldlabel=uq126&fieldlabel=uq127&fieldlabel=uq128&fieldlabel=uq136&fieldlabel=uq138&fieldlabel=uq141&fieldlabel=uq143&fieldlabel=uq164&fieldlabel=uq205&fieldlabel=uq167&fieldlabel=uq178&fieldlabel=uq185&fieldlabel=uq186&map-name%5B%5D=%E5%BA%97%E9%93%BA%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq101&map-text%5B%5D=&map-name%5B%5D=%E7%AB%99%E7%82%B9&map-uq%5B%5D=uq143&map-text%5B%5D=&map-name%5B%5D=%E5%95%86%E5%93%81%E9%93%BE%E6%8E%A5&map-uq%5B%5D=uq165&map-text%5B%5D=&map-name%5B%5D=MSKU&map-uq%5B%5D=uq102&map-text%5B%5D=&map-name%5B%5D=%E7%88%B6ASIN&map-uq%5B%5D=uq194&map-text%5B%5D=&map-name%5B%5D=ASIN&map-uq%5B%5D=uq105&map-text%5B%5D=&map-name%5B%5D=%E6%9C%AC%E5%9C%B0SKU&map-uq%5B%5D=uq103&map-text%5B%5D=&map-name%5B%5D=FNSKU&map-uq%5B%5D=uq154&map-text%5B%5D=&map-name%5B%5D=%E6%9C%AC%E5%9C%B0SKU%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq141&map-text%5B%5D=&map-name%5B%5D=%E4%BA%A7%E5%93%81%E5%90%8D%E7%A7%B0&map-uq%5B%5D=uq104&map-text%5B%5D=&map-name%5B%5D=7%E5%A4%A9%E9%94%80%E9%87%8F&map-uq%5B%5D=uq107&map-text%5B%5D=&map-name%5B%5D=14%E5%A4%A9%E9%94%80%E9%87%8F&map-uq%5B%5D=uq108&map-text%5B%5D=&map-name%5B%5D=30%E5%A4%A9%E9%94%80%E9%87%8F&map-uq%5B%5D=uq109&map-text%5B%5D=&map-name%5B%5D=90%E5%A4%A9%E9%94%80%E9%87%8F&map-uq%5B%5D=uq110&map-text%5B%5D=&map-name%5B%5D=%E6%97%A5%E5%9D%87%E9%94%80%E9%87%8F&map-uq%5B%5D=uq114&map-text%5B%5D=&map-name%5B%5D=%E6%8E%92%E5%90%8D&map-uq%5B%5D=uq178&map-text%5B%5D=&map-name%5B%5D=%E5%88%A9%E6%B6%A6%EF%BC%88%E5%8E%9F%E5%A7%8B%E8%B4%A7%E5%B8%81%EF%BC%89&map-uq%5B%5D=uq205&map-text%5B%5D=&map-name%5B%5D=%E5%94%AE%E4%BB%B7&map-uq%5B%5D=uq164&map-text%5B%5D=&map-name%5B%5D=7%E5%A4%A9%E9%80%80%E8%B4%A7%E9%87%8F&map-uq%5B%5D=uq118&map-text%5B%5D=&map-name%5B%5D=7%E5%A4%A9%E9%80%80%E8%B4%A7%E7%8E%87&map-uq%5B%5D=uq119&map-text%5B%5D=&map-name%5B%5D=30%E5%A4%A9%E9%80%80%E8%B4%A7%E9%87%8F&map-uq%5B%5D=uq172&map-text%5B%5D=&map-name%5B%5D=30%E5%A4%A9%E9%80%80%E8%B4%A7%E7%8E%87&map-uq%5B%5D=uq173&map-text%5B%5D=&map-name%5B%5D=%E4%B8%8A%E6%9E%B6%E6%97%B6%E9%97%B4&map-uq%5B%5D=uq167&map-text%5B%5D=&map-name%5B%5D=%E5%BA%93%E5%AD%98%E7%8A%B6%E6%80%81&map-uq%5B%5D=uq106&map-text%5B%5D=&map-name%5B%5D=%E5%8F%AF%E5%94%AE&map-uq%5B%5D=uq124&map-text%5B%5D=&map-name%5B%5D=%E5%BE%85%E5%85%A5%E5%BA%93&map-uq%5B%5D=uq125&map-text%5B%5D=&map-name%5B%5D=%E5%9C%A8%E9%80%94&map-uq%5B%5D=uq128&map-text%5B%5D=&map-name%5B%5D=%E9%A2%84%E7%95%99&map-uq%5B%5D=uq126&map-text%5B%5D=&map-name%5B%5D=%E6%9C%AC%E5%9C%B0%E5%BA%93%E5%AD%98&map-uq%5B%5D=uq122&map-text%5B%5D=&map-name%5B%5D=%E8%AE%A1%E5%88%92%E5%85%A5%E5%BA%93&map-uq%5B%5D=uq127&map-text%5B%5D=&map-name%5B%5D=%E9%87%87%E8%B4%AD%E5%9C%A8%E9%80%94&map-uq%5B%5D=uq120&map-text%5B%5D=&map-name%5B%5D=%E6%80%BB%E5%9C%A8%E9%80%94%E9%87%8F(%E9%BB%98%E8%AE%A4%E8%AE%BE%E7%BD%AE)&map-uq%5B%5D=uq186&map-text%5B%5D=&map-name%5B%5D=%E6%80%BB%E5%BA%93%E5%AD%98%E9%87%8F(%E9%BB%98%E8%AE%A4%E8%AE%BE%E7%BD%AE)&map-uq%5B%5D=uq185&map-text%5B%5D=&map-name%5B%5D=%E7%94%B3%E8%AF%B7%E8%A1%A5%E8%B4%A7%E9%87%8F&map-uq%5B%5D=uq138&map-text%5B%5D=&map-name%5B%5D=%E5%A4%87%E6%B3%A8&map-uq%5B%5D=uq136&map-text%5B%5D=&templateName=&templateId=1052958&datasOpen=2&memcacheKey=4d056461ff480631977657c53909f93d&showRmbColumn=2&pageSave=1&operateType=5&params=&InterfaceUrl=&mainMenu=&hiddenPage=&hiddenPageSize=&tableBase=&isMerage=2&showRmbColumn=2
```
响应里会得到一个 excel 文件地址
```
HTTP/1.1 200 OK
Date: Thu, 21 May 2026 09:05:43 GMT
Content-Type: text/html; charset=UTF-8
Connection: keep-alive
Access-Control-Allow-Origin: https://private.mabangerp.com
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 604800
Set-Cookie: lang=cn; expires=Sat, 20-Jun-2026 09:05:33 GMT
Expires: Thu, 19 Nov 1981 08:52:00 GMT
Cache-Control: no-store, no-cache, must-revalidate, post-check=0, pre-check=0
Pragma: no-cache
X-WAF-UUID: 47b928e95b3260119f53b4e01b412934-433ce6c0abbcdd55927f08f69b661853
Content-Length: 122

{"success":true,"gourl":"https:\/\/upload.mabangerp.com\/stock\/orderexport\/1086441BZGHA00gkKn177935434028626600769.xls"}
```