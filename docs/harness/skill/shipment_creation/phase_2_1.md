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
```html
<div data-testid="packing-method-box" class="decision-switch-item packing-method-box packing-method-box-override-min-max-width clickable selected"><div><div data-testid="packing-method-box-content" class="packing-method-box-content"><div data-testid="packing-method-box-content-header" class="packing-method-box-content-header margin-top-10px"><span class="inline-block"><h5>标准包装方式：</h5></span><h5 class="packing-method-box-content-header-packgroup-count" data-testid="packing-method-box-content-header-packgroup-count">1 个组</h5></div><strong class="packing-method-box-content-no-discount">无配送折扣</strong><div data-testid="packing-method-box-content-information" class="packing-method-box-content-information"><span>这种标准包装方式不会优化库存分布，也不能让您享受到配送折扣。</span></div></div><kat-icon name="checkmark" class="checkmark-icon" size="small"></kat-icon></div></div>
```