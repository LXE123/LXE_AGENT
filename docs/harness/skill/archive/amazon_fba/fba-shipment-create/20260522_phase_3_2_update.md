# Shipment Creation Phase 3.2 Update 20260522

状态：Archive

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

有以下修改：
---
第一阶段，不会再从 service/test_files 获取装箱数据。如果已经在对应站点，不会再进入切换站点流程。

第二阶段，强制要求装箱数据只有 12 列。
目前已经修改成只要有对应字段即可。具体如下：
箱序号 -> 箱号来源
MSKU -> 商品 SKU
装箱数量 -> 每箱数量
长 / 宽 / 高 -> 尺寸
毛重 -> 重量

第三阶段，送达日期默认 30 天，不再考虑运输方式。


---

# phase 3_2

未选择日期时
在 DevTools 搜：
kat-date-picker[data-testid="kat-ship-date-picker"]
选择前
```html
<kat-date-picker data-testid="kat-ship-date-picker" id="sendByDatePicker" locale="zh-CN" value="" mobile-emulated-modal="" size="large" autocomplete="off" kat-aria-label="发货日期" state="error"><span slot="private-light-dom" style="max-width: 0px; max-height: 0px; overflow: hidden;"></span></kat-date-picker>
```
选择后
```html
<kat-date-picker data-testid="kat-ship-date-picker" id="sendByDatePicker" locale="zh-CN" value="2026/5/22" mobile-emulated-modal="" size="large" autocomplete="off" kat-aria-label="发货日期"><span slot="private-light-dom" style="max-width: 0px; max-height: 0px; overflow: hidden;"></span></kat-date-picker>
```
搜索当天日期看到这个（2026年5月22日）
选择前
```html
<td class="day on today selected font-weight-800"> <button type="button" part="calendar-day-21" aria-disabled="false" tabindex="0" aria-label="2026年5月22日. today date" aria-current="date" aria-pressed="true" data-day="22" class="kat-no-style highlighted font-weight-800"> 22 </button> </td>
```
选择后
```html
<td class="day on today selected font-weight-800"> <button type="button" part="calendar-day-21" aria-disabled="false" tabindex="0" aria-label="2026年5月22日. today date" aria-current="date" aria-pressed="true" data-day="22" class="kat-no-style highlighted font-weight-800"> 22 </button> </td>
```

运输方式 和 非亚马逊合作承运人
运输方式
选择前：
```html
<div class="select-header" part="dropdown-header" id="katal-id-415" title="" tabindex="0"> <div class="header-row"> <div class="header-row-text placeholder"> <div class="selection-text hidden"> <slot name="selected-option"><!----><!----></slot> </div> <div class="placeholder-text"> <slot name="placeholder"><!---->请选择<!----></slot> </div> <div class="header-row-overflow"></div> </div>  <div class="indicator"> <kat-icon size="small" name="chevron-down"></kat-icon> </div> </div> </div>
```
选择后：
```html
<div class="select-header" part="dropdown-header" id="katal-id-415" title="空运" tabindex="0"> <div class="header-row"> <div class="header-row-text value"> <div class="selection-text"> <slot name="selected-option"><!----><!----><!---->空运<!----><!----><!----></slot> </div> <div class="placeholder-text hidden"> <slot name="placeholder"><!---->请选择<!----></slot> </div> <div class="header-row-overflow"></div> </div>  <div class="indicator"> <kat-icon size="small" name="chevron-down"></kat-icon> </div> </div> </div>
```
非亚马逊合作承运人
选择前：
```html
<div class="select-header" part="dropdown-header" id="katal-id-414" title="" tabindex="0"> <div class="header-row"> <div class="header-row-text placeholder"> <div class="selection-text hidden"> <slot name="selected-option"><!----><!----></slot> </div> <div class="placeholder-text"> <slot name="placeholder"><!---->选择承运人<!----></slot> </div> <div class="header-row-overflow"></div> </div>  <div class="indicator"> <kat-icon size="small" name="chevron-down"></kat-icon> </div> </div> </div>
```

选择后：
```html
<div class="select-header" part="dropdown-header" id="katal-id-414" title="其他" tabindex="0"> <div class="header-row"> <div class="header-row-text value"> <div class="selection-text"> <slot name="selected-option"><!----><!----><span><!---->其他<!----><!----></span><!----><!----></slot> </div> <div class="placeholder-text hidden"> <slot name="placeholder"><!---->选择承运人<!----></slot> </div> <div class="header-row-overflow"></div> </div>  <div class="indicator"> <kat-icon size="small" name="chevron-down"></kat-icon> </div> </div> </div>
```
