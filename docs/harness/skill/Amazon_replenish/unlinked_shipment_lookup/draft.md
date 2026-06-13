和业务人员反复交流后，发现计算备货还有一个关键数据需要抓取，就是那些未正式关联到 amazon 的货件，是无法从 msku 数据中获取到的。
---
OK，那么这些数据从什么地方抓取呢，根据店铺名从下面请求中抓取
请求从下面这个网页中抓取 `https://private.mabangerp.com/index.php?mod=main.deliveryOrder&platform=amazon&version=1`
查找处于`WMS待配货`、`wms待装箱`和`待关联货件`状态的货件