# Logistics Select Draft

状态：Archive / Draft

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

进行物流优选时，
需要给 agent 提供什么信息
我认为需要这三个
1. 装箱数据单号  // 用来查询装箱数据，数据用来计算重量的
2. 货件编号 // 等于货件的名字
3. 货件编号的对应收货地址 // 必须的，有收货地址才能选物流

这里有一些问题 装箱数据编号 从哪获取呢？货件编号的对应收货地址又从哪获取？
根据我对实际业务的了解，
- 货件编号的对应收货地址由用户提供（目前创建货件流程的脚本中会发送详细的地址给用户）
- 装箱数据从本地文件夹获取（用户提供单号，然后从固定目录 artifacts/mabang_wms_consignment 获取）是最好的。
因为基本不存在一个稳定的 API 获取这些数据。

用户输入示例：
```
SP260226004	FBA19BY640PC	ONT8 - 24300 Nandina Ave 92551-9534 - Moreno Valley, CA - United States
SP260226004	FBA19BY8HL56	PSP3 - 64165 19th AVE 92240 - DESERT HOT SPRINGS, CA - United States
SP260226004	FBA19BYBG0H3	FWA4 - 9798 Smith Road 46809-9771 - FORT WAYNE, IN - United States
SP260226004	FBA19BYDKY6L	ABE8 - 401 Independence Road 08518-2200 - Florence, NJ - United States
SP260226004	FBA19BY60CM6	CLT2 - 10240 Old Dowd Rd 28214-8082 - Charlotte, NC - United States
```

- 怎么处理 FBA货件号对应着装箱数据excel里的哪个货件的？
答：怎么判断很简单 可以按顺序来匹配，第一行FBA编号 对应着第一个箱子，以此类推

---

那么吐出来的数据是什么呢？
目前的物流优选流程中会生成一个md文件，那么这个md文件会直接发送给用户。
那么 AI 能看到什么呢？
{
    success: boolean,
    message: string,
    exception：string,
}
message 中只有两种结果，一种是运行成功了。显示“已完成计算流程，文件已发送。”，一种是运行失败了，显示“物流优选流程失败”。
exception。如果报错了，就把报错信息写入 exception 让AI看到。没有就不写

---

我们必须还要添加物流数据更新的 skill 和相关脚本。

重点就是这个脚本，是在是有点大
