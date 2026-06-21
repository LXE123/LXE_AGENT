# Shipment Creation Phase 3 Germany Layout

状态：Archive

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

我又又在德国站遇到了新的一种页面布局，我想先了解的是目前有和其它已经适配的页面布局有元素重合吗。
发货日期
```html
<kat-input type="text" part="date-picker-input" class="input" placeholder="YYYY/MM/DD" value="" autocomplete="off" kat-aria-label="发货日期" unique-id="katal-id-450" size="large" inputmode="" enterkeyhint=""><span class="container"> <input part="input" id="katal-id-450" type="text" placeholder="YYYY/MM/DD" autocomplete="off" aria-label="发货日期" spellcheck="false" inputmode="" enterkeyhint="">  <span class="ring"></span> </span><span slot="private-light-dom" style="max-width: 0px; max-height: 0px; overflow: hidden;"></span></kat-input>
```

承运人
```html
<kat-dropdown data-testid="non-pcp-carrier-choices" placeholder="选择承运人" searchable="true" max-height="400px" mobile-emulated-modal="" size="large" expand-direction="auto"><kat-option value="LINP" aria-selected="false" role="option" tabindex="-1"><a target="_blank" rel="noreferrer" href="https://1st56.com/group/index/">一代国际 (ShipTrack)</a></kat-option><kat-option value="EIAI" aria-selected="false" role="option" tabindex="-1"><a target="_blank" rel="noreferrer" href="https://www.longzhou100.com">龙洲现代 (ShipTrack)</a></kat-option><kat-option value="DEUTP" aria-selected="false" role="option" tabindex="-1">Deutsche Post DHL</kat-option><kat-option value="DPDXX" aria-selected="false" role="option" tabindex="-1">Deutscher Paket Dienst</kat-option><kat-option value="DHLC" aria-selected="false" role="option" tabindex="-1">DHL Airways</kat-option><kat-option value="DHLEX" aria-selected="false" role="option" tabindex="-1">DHL DE Domestic Express</kat-option><kat-option value="FDE" aria-selected="false" role="option" tabindex="-1">FedEx</kat-option><kat-option value="FDEG" aria-selected="false" role="option" tabindex="-1">FedEx Ground</kat-option><kat-option value="GLSYS" aria-selected="false" role="option" tabindex="-1">General Logistics Systems</kat-option><kat-option value="HRMES" aria-selected="false" role="option" tabindex="-1">Hermes</kat-option><kat-option value="TNXR" aria-selected="false" role="option" tabindex="-1">TNT Express Inc.</kat-option><kat-option value="TOFLX" aria-selected="false" role="option" tabindex="-1">Trans-o-flex Schnell-Lieferdienst</kat-option><kat-option value="UPSI" aria-selected="false" role="option" tabindex="-1">UPS International</kat-option><kat-option value="UPSN" aria-selected="false" role="option" tabindex="-1">UPS（非合作承运人）</kat-option><kat-option value="OTHER" aria-selected="false" role="option" tabindex="-1">其他</kat-option><span slot="private-light-dom" style="max-width: 0px; max-height: 0px; overflow: hidden;"></span></kat-dropdown>
```

运输方式
```html
<kat-dropdown data-testid="transportation-mode-dropdown" placeholder="请选择" options="[{&quot;name&quot;:&quot;空运&quot;,&quot;value&quot;:&quot;AIR&quot;},{&quot;name&quot;:&quot;海运&quot;,&quot;value&quot;:&quot;OCEAN&quot;},{&quot;name&quot;:&quot;陆运&quot;,&quot;value&quot;:&quot;GROUND&quot;}]" size="large" mobile-emulated-modal="" expand-direction="auto"><div class="kat-select-container"> <div class="select-header" part="dropdown-header" id="katal-id-430" title="" tabindex="0"> <div class="header-row"> <div class="header-row-text placeholder"> <div class="selection-text hidden"> <slot name="selected-option"><!----><!----></slot> </div> <div class="placeholder-text"> <slot name="placeholder"><!---->请选择<!----></slot> </div> <div class="header-row-overflow"></div> </div>  <div class="indicator"> <kat-icon size="small" name="chevron-down"></kat-icon> </div> </div> </div> <span class="ring"></span> <div part=""> <div class="select-options" part=" dropdown-options"> <!----> <div class="option-inner-container" part=""> <div class="option-inner-content" tabindex="-1" part=""> <slot name="select-header"><!----><!----></slot> <slot role="listbox"><!----><!----> <kat-option tabindex="-1" part="dropdown-option0" value="AIR" aria-selected="false" role="option"> <div class="standard-option-content"> <div class="standard-option-name"><!---->空运<!----></div> <div class="standard-option-icon"><!----><!----></div> </div> </kat-option> <!----> <kat-option tabindex="-1" part="dropdown-option1" value="OCEAN" aria-selected="false" role="option"> <div class="standard-option-content"> <div class="standard-option-name"><!---->海运<!----></div> <div class="standard-option-icon"><!----><!----></div> </div> </kat-option> <!----> <kat-option tabindex="-1" part="dropdown-option2" value="GROUND" aria-selected="false" role="option"> <div class="standard-option-content"> <div class="standard-option-name"><!---->陆运<!----></div> <div class="standard-option-icon"><!----><!----></div> </div> </kat-option> <!----><!----></slot>  </div> <slot name="select-footer"><!----><!----></slot> </div> </div> </div> <div class="metadata"><!----> <!----></div> </div><span slot="private-light-dom" style="max-width: 0px; max-height: 0px; overflow: hidden;"></span></kat-dropdown>
```

送达日期
```html
<kat-input type="text" part="date-picker-input" class="input" placeholder="YYYY/MM/DD" value="" autocomplete="off" kat-aria-label="undefined" unique-id="katal-id-456" size="large" inputmode="" enterkeyhint=""><span class="container"> <input part="input" id="katal-id-456" type="text" placeholder="YYYY/MM/DD" autocomplete="off" aria-label="undefined" spellcheck="false" inputmode="" enterkeyhint="">  <span class="ring"></span> </span><span slot="private-light-dom" style="max-width: 0px; max-height: 0px; overflow: hidden;"></span></kat-input>
```
