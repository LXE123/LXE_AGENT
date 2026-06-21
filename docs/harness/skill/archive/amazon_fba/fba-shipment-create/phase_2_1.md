# Shipment Creation Phase 2.1

状态：Archive

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

如何判断第一阶段结束
未成功
```html
<div class="kat-row flex-nowrap" data-testid="header-component"><div class="kat-col padding-0-10px"><div class="flexRow flex-align-baseline"><div><div class="inline-block"><h4 data-testid="step-header-title">第 1 步： 选择要运送的库存</h4></div></div><div class="flex-1" data-testid="step-header-detail"></div></div></div></div>
```
成功
```html
<div class="kat-row flex-nowrap" data-testid="header-component"><div class="kat-col padding-0-10px"><div class="flexRow flex-align-baseline"><div class="inline-block margin-right-4px margin-top-2px flex-align-self-start"><kat-icon name="check" size="small" data-testid="header-checkmark"></kat-icon></div><div><div class="inline-block"><h4 data-testid="step-header-title">第 1 步： 已确认要发送的库存</h4></div></div><div class="flex-1" data-testid="step-header-detail"><div class="detail"><span class="detail-title"><span class="detail-title-value" data-testid="bold-translation">SKU：<strong>29</strong></span></span></div><div class="detail"><span class="detail-title"><span class="detail-title-value" data-testid="bold-translation">商品数量：<strong>1005</strong></span></span></div><div class="detail"><span class="detail-title"><span class="detail-title-value" data-testid="shipFromAddress">发货地址：<strong>shendalangjiedaoxinshishequlangjinglu2hao808</strong>, <strong>shenz</strong>, <strong>Guan</strong>, <strong>518</strong></span></span></div></div></div></div></div>
```

第二阶段，如果有这个元素的话需要先点一下，再进行原本的操作
未选择
```html
<div data-testid="packing-method-box" class="decision-switch-item packing-method-box packing-method-box-override-min-max-width clickable not-selected clickable"><div><div data-testid="packing-method-box-content" class="packing-method-box-content"><div data-testid="packing-method-box-content-header" class="packing-method-box-content-header margin-top-10px"><span class="inline-block"><h5>标准包装方式：</h5></span><h5 class="packing-method-box-content-header-packgroup-count" data-testid="packing-method-box-content-header-packgroup-count">1 个组</h5></div><strong class="packing-method-box-content-no-discount">无配送折扣</strong><div data-testid="packing-method-box-content-information" class="packing-method-box-content-information"><span>这种标准包装方式不会优化库存分布，也不能让您享受到配送折扣。</span></div></div></div></div>
```
已选择
```html
<div data-testid="packing-method-box" class="decision-switch-item packing-method-box packing-method-box-override-min-max-width clickable selected"><div><div data-testid="packing-method-box-content" class="packing-method-box-content"><div data-testid="packing-method-box-content-header" class="packing-method-box-content-header margin-top-10px"><span class="inline-block"><h5>标准包装方式：</h5></span><h5 class="packing-method-box-content-header-packgroup-count" data-testid="packing-method-box-content-header-packgroup-count">1 个组</h5></div><strong class="packing-method-box-content-no-discount">无配送折扣</strong><div data-testid="packing-method-box-content-information" class="packing-method-box-content-information"><span>这种标准包装方式不会优化库存分布，也不能让您享受到配送折扣。</span></div></div><kat-icon name="checkmark" class="checkmark-icon" size="small"></kat-icon></div></div>
```


一定要有这个才是正式进入第二阶段
```html
<div class="pack-group-controls" data-testid="pack-group-controls"><div class="margin-bottom-12px"><strong>包装信息</strong></div><div>这些商品需要多少个包装箱来装箱？</div><div class="kat-row"><div class="kat-col-xs-8 padding-left-0"><kat-radiobutton-group name="cli-input-method" class="margin-top-8px margin-bottom-0px" data-testid="cli-input-method-radio-input"><div class="kat-options kat-spacing-group"><!----><!----><!----> <kat-radiobutton name="cli-input-method" label="所有商品都将装入同一包装箱中" value="EVERYTHING_IN_A_BOX"><input type="radio" part="radiobutton-input" class="kat-radio" slot="radio" role="radio" id="katal-id-480" name="cli-input-method" value="EVERYTHING_IN_A_BOX" aria-label="所有商品都将装入同一包装箱中" aria-describedby="katal-id-481" aria-labelledby="undefined"><span class="kat-radiobutton-icon" part="radiobutton-icon" slot="radio"></span></kat-radiobutton> <!----> <kat-radiobutton name="cli-input-method" label="需要多个包装箱" value="MULTI_BOX_WEBFORM"><input type="radio" part="radiobutton-input" class="kat-radio" slot="radio" role="radio" id="katal-id-482" name="cli-input-method" value="MULTI_BOX_WEBFORM" aria-label="需要多个包装箱" aria-describedby="katal-id-483" aria-labelledby="undefined"><span class="kat-radiobutton-icon" part="radiobutton-icon" slot="radio"></span></kat-radiobutton> <!----><!----><!----></div></kat-radiobutton-group></div><div class="kat-col-xs-4 flex-row flex-align-right flex-align-end"><kat-button label="确认" variant="secondary" disabled="true" class="margin-bottom-10px" data-testid="cli-input-method-verify-button" size="base" type="button"></kat-button></div></div></div>
```
