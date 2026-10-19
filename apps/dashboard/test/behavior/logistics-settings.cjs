// Real local Dashboard DOM and React hooks; the fixture substitutes only IPC.
module.exports = async ({win,js,step,settle,click,key,waitFor,assert}) => {
  const textClick = async (text, scope=".logistics-settings") => {
    await js(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(el=>el.textContent===${JSON.stringify(text)}); if(!el || el.disabled) throw new Error('button unavailable: '+${JSON.stringify(text)}); el.click(); })()`); await settle();
  };
  const input = async (name,value) => {
    await js(`(() => { const el=document.querySelector('[name="logistics-${name}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`); await settle();
  };
  const select = async (name,value) => {
    await js(`(() => { const el=document.querySelector('[name="logistics-${name}"]'); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await settle();
  };
  const nav = async text => { await js(`[...document.querySelectorAll('.desktop-settings-nav-item')].find(el=>el.textContent.includes(${JSON.stringify(text)})).click()`); await settle(); };
  const create = async (name,account) => {
    await textClick("添加物流商"); await select("provider","tiantai"); await input("name",name); await input("account",account); await select("store","one=="); await textClick("保存配置");
    await waitFor("!document.querySelector('.logistics-editor')", "saved profile closes editor");
  };
  await step("navigation order, empty state and independent save boundary",async()=>{
    await js("behavior.mountLogistics()"); await waitFor("Boolean(document.querySelector('#open-logistics'))","shell mounted"); await click("#open-logistics");
    await waitFor("document.body.innerText.includes('尚未配置物流商')","empty state");
    const labels=await js("[...document.querySelectorAll('.desktop-settings-nav-item strong')].map(el=>el.textContent)");
    assert.equal(labels[labels.indexOf("ERP 账号")+1],"物流商配置"); assert.equal(labels[labels.indexOf("物流商配置")+1],"飞书");
    assert.equal(await js("document.querySelectorAll('.desktop-settings-modal form').length"),0);
    assert.equal(await js("document.querySelectorAll('.desktop-settings-modal > footer [type=submit]').length"),0);
    await textClick("添加物流商");
    assert.equal(await js("document.querySelector('[name=logistics-store]').value"),"");
    assert.equal(await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent==='保存配置').disabled"),true);
    await textClick("取消编辑");
  });
  await step("two Tiantai accounts save separately without closing the settings dialog",async()=>{
    await create("天泰-新棱镜","深圳市新棱镜贸易有限公司"); await create("天泰-久艺","深圳市久艺电子商务有限公司");
    assert.equal(await js("document.querySelectorAll('.logistics-card').length"),2);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"),true);
    assert.equal((await js("behavior.state().calls")).filter(c=>/saveSetup|restart/.test(c.operation)).length,0);
    assert.match(await js("document.querySelector('.desktop-settings-nav-item[aria-current=page]').textContent"),/已配置 2 条/);
  });
  await step("draft guards section switching, cancellation, Escape and modal closing",async()=>{
    await textClick("编辑"); await input("name","未保存草稿"); await nav("ERP 账号");
    await waitFor("document.querySelectorAll('[role=dialog]').length===2","draft dialog");
    await key("Escape"); assert.equal(await js("document.querySelector('[name=logistics-name]').value"),"未保存草稿");
    await click(".desktop-close-button"); await textClick("确认",".desktop-confirm-dialog");
    await waitFor("!document.querySelector('.desktop-settings-modal')","confirmed close");
    const readsBefore=(await js("behavior.logistics.calls()")).filter(c=>c.operation==='read').length;
    await click("#open-logistics"); await waitFor("document.querySelectorAll('.logistics-card').length===2","reload saved data");
    assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='read').length,readsBefore+1);
    await textClick("编辑"); assert.equal(await js("document.querySelector('[name=logistics-name]').value"),"天泰-新棱镜"); await textClick("取消编辑");
  });
  await step("toggle and deletion use independent revisioned actions with confirmation",async()=>{
    await textClick("停用"); await waitFor("document.body.innerText.includes('已停用')","disabled profile"); await textClick("启用");
    await textClick("删除"); assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='delete').length,0);
    await textClick("取消",".desktop-confirm-dialog"); await textClick("删除"); await textClick("确认",".desktop-confirm-dialog");
    await waitFor("document.querySelectorAll('.logistics-card').length===1","delete persisted");
  });
  await step("refresh reports stopped, renamed, missing, ambiguous and unavailable without dropping binding",async()=>{
    await js("behavior.logistics.patch({stores:[{store_id:'one==',store_name:'Amazon 店铺一 深圳市公司 A',running:false}]})"); await textClick("刷新店铺");
    assert.match(await js("document.querySelector('.logistics-card').textContent"),/店铺未运行/);
    await js("behavior.logistics.patch({stores:[{store_id:'one==',store_name:'已更名',running:true}]})"); await textClick("刷新店铺");
    assert.match(await js("document.querySelector('.logistics-card').textContent"),/店铺名称冲突/);
    await textClick("编辑"); await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent.includes('确认使用当前店铺名称')).click()"); await settle(); await textClick("保存配置");
    await waitFor("!document.querySelector('.logistics-editor')","name confirmed");
    await js("behavior.logistics.patch({stores:[]})"); await textClick("刷新店铺"); await textClick("编辑");
    assert.equal(await js("document.querySelector('[name=logistics-store]').value"),"one=="); await textClick("取消编辑");
    await js("behavior.logistics.patch({stores:[{store_id:'one==',store_name:'已更名',running:true},{store_id:'one==',store_name:'重复',running:true}]})"); await textClick("刷新店铺");
    assert.match(await js("document.querySelector('.logistics-card').textContent"),/店铺绑定不唯一/);
    await js("behavior.logistics.patch({stores:[],stores_error:'ConnectionError: fixture client offline'})"); await textClick("刷新店铺");
    assert.match(await js("document.querySelector('.logistics-card').textContent"),/店铺状态不可读/); assert.equal(await js("document.querySelectorAll('.logistics-card').length"),1);
  });
  await step("provider fields, duplicate click suppression and revision conflict preserve drafts",async()=>{
    await textClick("添加物流商");
    for(const provider of ['feiwo','yuntuo','jiufang']) {
      await select('provider',provider); assert.equal(await js("Boolean(document.querySelector('[name=logistics-account]'))"),false);
      assert.equal(await js("Boolean(document.querySelector('[name=logistics-store]'))"),provider!=='jiufang');
    }
    await input('name','九方公开'); await js("behavior.logistics.patch({revision:behavior.logistics.state().revision+1})"); await textClick('保存配置');
    await waitFor("document.body.innerText.includes('Revision conflict')","actual conflict"); assert.equal(await js("document.querySelector('[name=logistics-name]').value"),'九方公开');
    await textClick('刷新店铺'); await textClick('保存配置'); assert.match(await js("document.body.innerText"),/Revision conflict/);
    await textClick('取消编辑'); await textClick('确认','.desktop-confirm-dialog'); await textClick('添加物流商'); await select('provider','jiufang'); await input('name','九方公开');
    await js("behavior.logistics.holdSave(true)"); await textClick('保存配置');
    const before=(await js("behavior.logistics.calls()")).filter(c=>c.operation==='save').length;
    await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent==='保存配置').click()"); await settle();
    assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='save').length,before);
    await js("behavior.logistics.holdSave(false);behavior.logistics.releaseSave()"); await waitFor("!document.querySelector('.logistics-editor')","held save completed");
    assert.match(await js("document.body.innerText"),/公开接口/);
  });
  await step("configuration errors remain distinct from an empty configuration and retry recovers",async()=>{
    await js("behavior.logistics.failRead(true)"); await textClick('刷新店铺'); assert.match(await js("document.body.innerText"),/JSONDecodeError: fixture broken profiles/);
    await js("behavior.logistics.failRead(false)"); await textClick('重新加载'); await waitFor("!document.body.innerText.includes('JSONDecodeError')","retry recovered");
  });
  await step("provider switching at the bottom keeps the editor and scroll position stable",async()=>{
    await js("behavior.logistics.patch({stores:[{store_id:'one==',store_name:'Amazon 店铺一 深圳市公司 A',running:true}],stores_error:null})");
    await textClick('刷新店铺'); await textClick('添加物流商');
    for (const width of [1200, 680]) {
      win.setSize(width,900); await settle();
      await select('provider','wesa'); await select('store','one==');
      await js("(() => { const content=document.querySelector('.desktop-settings-content'); content.scrollTop=content.scrollHeight; document.querySelector('[name=logistics-provider]').focus({preventScroll:true}); })()");
      await settle();
      const geometry = () => js("(() => { const content=document.querySelector('.desktop-settings-content'); const provider=document.querySelector('[name=logistics-provider]'); return {scroll:content.scrollTop,top:provider.getBoundingClientRect().top,height:document.querySelector('.logistics-editor').getBoundingClientRect().height}; })()");
      const before = await geometry();
      assert.ok(before.scroll>0,'the regression actually exercises a scrolled editor');
      for (const provider of ['jiufang','feiwo','tiantai','yuntuo','wesa','jiufang']) {
        await select('provider',provider);
        const after = await geometry();
        assert.ok(Math.abs(after.scroll-before.scroll)<=1,`${width}px ${provider}: scroll position moved`);
        assert.ok(Math.abs(after.top-before.top)<=1,`${width}px ${provider}: provider selector jumped`);
        assert.ok(Math.abs(after.height-before.height)<=1,`${width}px ${provider}: editor height changed`);
        assert.equal(await js("document.activeElement?.getAttribute('name')"),'logistics-provider');
      }
    }
    await textClick('取消编辑'); await textClick('确认','.desktop-confirm-dialog');
  });
  await step("Chinese and English narrow layouts have no horizontal overflow",async()=>{
    await win.setSize(680,900);
    for(const language of ['zh','en']) {
      await js(`[...document.querySelectorAll('.desktop-settings-language button')].find(el=>el.textContent===${JSON.stringify(language==='zh'?'中文':'EN')})?.click()`); await settle();
      assert.match(await js("document.querySelector('.logistics-settings h2').textContent"),language==='zh'?/物流商配置/:/Logistics providers/);
      assert.equal(await js("document.querySelector('.desktop-settings-content').scrollWidth <= document.querySelector('.desktop-settings-content').clientWidth+1"),true);
      assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"),true);
      if(process.env.LXE_LOGISTICS_SCREENSHOT) {
        const fs=require('node:fs');
        fs.writeFileSync(process.env.LXE_LOGISTICS_SCREENSHOT.replace(/\.png$/,`-${language}.png`),(await win.webContents.capturePage()).toPNG());
      }
    }
  });
};
