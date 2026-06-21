# Shipment Create Draft

状态：Archive / Draft

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

SKILL
如何处理货件全流程

--- 

用户发送消息如下时
FBA15  SP260317008  Amazon-YRZ-UK英国仓(FBA)  装箱完成
说明用户要开始处理货件

---

第一阶段
第一步 下载SP260317008的装箱数据，使用工具一
第二步 打开对应亚马逊对应店铺
第三步 进入Amazon-YRZ-英国站点发送货件页面（URL: https://sellercentral.amazon.com/fba/sendtoamazon）
第四步 什么都别管，做这两步，1. 点击重新开始。2. 选择文件上传选项
第五步 点击“生成并下载模板”按钮，拿到模板文件，调用工具二把 SP260317008 的数据填入该模板文件
第六步 点击“上传模板”按钮，上传刚才填写好的模板文件
第七步 对比货物数量，确定和装箱数据里的msku数量一致，点击下一步
---
第二阶段


---

工具一：目前项目中已经有相关实现，具体代码:
async def ensure_consignment_excel_ready(consignment_no: str) -> Path:
    """优先通过 WMS 导出托运单 Excel，失败时回退本地文件"""
    if enable_export:
        try:
            return await download_consignment_excel_from_wms(normalized)  # ← 优先
        except Exception:
            if strict_export:
                raise
            logger.warning(f"WMS导出失败，回退本地Excel")
    return find_consignment_excel(normalized)  # ← 回退本地

工具二：分为美国站和非美国站：“def write_amazon_us(df_result):
    """
    将汇总数据写入 amazon_us.xlsx
    目标位置：Create workflow – template 工作表
    数据写入：第7行起，Merchant SKU (A列), Quantity (B列)
    """
    print('【步骤2】写入 amazon_us.xlsx...')
    try:
        wb_us = load_workbook('amazon_us.xlsx')
        ws_us = wb_us['Create workflow – template']

        # 清空原有数据（保留表头，从第7行开始清空，表头在第6行）
        max_row = ws_us.max_row
        if max_row > 6:
            ws_us.delete_rows(7, max_row - 6)

        # 写入新数据（从第7行开始，保留第6行的表头）
        for idx, row in enumerate(dataframe_to_rows(df_result, index=False, header=False), start=7):
            ws_us.cell(row=idx, column=1, value=row[0])  # Merchant SKU - A列
            ws_us.cell(row=idx, column=2, value=row[1])  # Quantity - B列

        wb_us.save('amazon_us.xlsx')
        print(f'  -> 已写入 {len(df_result)} 行数据到 Merchant SKU 和 Quantity 列')
        return True
    except PermissionError:
        print('  -> 错误：amazon_us.xlsx 文件被占用，请关闭后重试')
        return False


def write_amazon_notus(df_result):
    """
    将汇总数据写入 amazon_notus.xlsx
    目标位置：Create workflow – template 工作表
    数据写入：第9行起，Merchant SKU (A列), Quantity (B列), Prep owner (C列), Labeling owner (D列)
    """
    print('【步骤3】写入 amazon_notus.xlsx...')
    try:
        wb_notus = load_workbook('amazon_notus.xlsx')
        ws_notus = wb_notus['Create workflow – template']

        # 清空原有数据（保留表头，从第9行开始清空，表头在第8行）
        max_row = ws_notus.max_row
        if max_row > 8:
            ws_notus.delete_rows(9, max_row - 8)

        # 写入新数据（从第9行开始，保留第8行的表头）
        for idx, row in enumerate(dataframe_to_rows(df_result, index=False, header=False), start=9):
            ws_notus.cell(row=idx, column=1, value=row[0])  # Merchant SKU - A列
            ws_notus.cell(row=idx, column=2, value=row[1])  # Quantity - B列
            ws_notus.cell(row=idx, column=3, value='seller')  # Prep owner - C列
            ws_notus.cell(row=idx, column=4, value='seller')  # Labeling owner - D列

        wb_notus.save('amazon_notus.xlsx')
        print(f'  -> 已写入 {len(df_result)} 行数据，Prep owner 和 Labeling owner 已设为 seller')
        return True
    except PermissionError:
        print('  -> 错误：amazon_notus.xlsx 文件被占用，请关闭后重试')
        wb_notus.save('amazon_notus_output.xlsx')
        print('  -> 已生成 amazon_notus_output.xlsx 作为备选')
        return False”
        
---

html 元素
勾选文件上传
```HTML
<kat-radiobutton name="file-upload" value="STA_SKU_SELECTION_METHOD_FILE_UPLOAD" label="文件上传" data-testid="file-upload-radio-button" checked="true"><template shadowrootmode="open"><!----> <div class="wrapper"> <div class="indicator"><slot name="radio"></slot></div> <div class="text"> <slot> <kat-label part="radiobutton-label" for="katal-id-219" variant="default" text="文件上传"><template shadowrootmode="open"><!----> <label class=" " for="katal-id-219"> <slot><!----> <span part="label-text"><!---->文件上传<!----></span><!----></slot> <span class="private"> <slot name="private-light-dom"></slot></span> </label> <!----></template><span slot="private-light-dom"><label for="katal-id-219"><!----> <span part="label-text"><!---->文件上传<!----></span><!----></label></span></kat-label> <kat-label part="radiobutton-constraint-label" variant="constraint" id="katal-id-220" for="katal-id-219"><template shadowrootmode="open"><!----> <label class="hide" for="katal-id-219"> <slot><!----> <!----></slot> <span class="private"> <slot name="private-light-dom"></slot></span> </label> <!----></template><span slot="private-light-dom"><label for="katal-id-219"><!----> <!----></label></span></kat-label> </slot> </div> </div> <!----></template><input type="radio" part="radiobutton-input" class="kat-radio" slot="radio" role="radio" id="katal-id-219" name="file-upload" value="STA_SKU_SELECTION_METHOD_FILE_UPLOAD" aria-label="文件上传" aria-describedby="katal-id-220" aria-labelledby="undefined"><span class="kat-radiobutton-icon" part="radiobutton-icon" slot="radio" checked=""></span></kat-radiobutton>
```
上传第一步文件
```HTML
<input data-testid="file-upload-button-input" type="file" class="display-none">
<kat-button label="上传已填写的文件" variant="primary" id="manifest-file-upload-button" data-testid="manifest-file-upload-button" size="base" type="button"><button class="button" type="button"> <div class="icon__container">  <span class="icon"><slot name="icon"></slot></span> </div> <div class="content"> <slot> <span><!---->上传已填写的文件<!----></span> </slot> </div> <div tabindex="-1"></div> </button></kat-button>
```
获取下载模板：
```HTML
<a data-testid="manifest-file-upload-template-generator-download-link" href="https://m.media-amazon.com/images/G/01/STA_Manifest_File_Upload/Imperial_System_Version_Prep_Discontinued/ZH/ManifestFileUpload_Template_IncludeCasePack_IncludeExpirationDate_IncludeMLC_MPL.xlsx" download="https://m.media-amazon.com/images/G/01/STA_Manifest_File_Upload/Imperial_System_Version_Prep_Discontinued/ZH/ManifestFileUpload_Template_IncludeCasePack_IncludeExpirationDate_IncludeMLC_MPL.xlsx"><kat-button data-testid="manifest-file-upload-template-generator-download-button" label="生成并下载模板" variant="secondary" size="base" type="button"></kat-button></a>
```
重新开始按钮元素
三按钮，可用来重新开始
```HTML
<div class="right"><div class="flexRow buttonTileRow flexAlignRight flex-nowrap"><div class="buttonTile start-new-workflow-button"><a href="/fba/sendtoamazon/workflow/void?wf=wfeb6cf30f-53ab-4063-ba19-e5f1b3a31862"><kat-button variant="secondary" size="base" label="删除工作流程" data-testid="delete-workflow-cancel-shipment-button" type="button"><template shadowrootmode="open" shadowrootdelegatesfocus=""><!----> <button class="button" type="button"> <div class="icon__container">  <span class="icon"><slot name="icon"></slot></span> </div> <div class="content"> <slot> <span><!---->删除工作流程<!----></span> </slot> </div> <div tabindex="-1"></div> </button> <!----></template></kat-button></a></div><div class="buttonTile start-new-workflow-button"><kat-button data-testid="start-new-button" variant="secondary" size="base" label="重新开始" type="button"><template shadowrootmode="open" shadowrootdelegatesfocus=""><!----> <button class="button" type="button"> <div class="icon__container">  <span class="icon"><slot name="icon"></slot></span> </div> <div class="content"> <slot> <span><!---->重新开始<!----></span> </slot> </div> <div tabindex="-1"></div> </button> <!----></template></kat-button></div><div class="buttonTile start-new-workflow-button"><a href="/gp/fba/inbound-queue/index.html/ref=ag_xx_cont_fbashipq" data-testid="shipping-queue-anchor"><kat-button data-testid="shipping-queue-button" label="转到“货件处理进度”" size="base" variant="secondary" type="button"><template shadowrootmode="open" shadowrootdelegatesfocus=""><!----> <button class="button" type="button"> <div class="icon__container">  <span class="icon"><slot name="icon"></slot></span> </div> <div class="content"> <slot> <span><!---->转到“货件处理进度”<!----></span> </slot> </div> <div tabindex="-1"></div> </button> <!----></template></kat-button></a></div></div></div>
```
