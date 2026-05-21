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

那么下一步就是怎么用这个获取好的店铺 id 去查询 msku 了

大概要发两个请求，
第一个请求`获取 ids`有两种请求方式：
第一种
请求： 
```HTTP
```