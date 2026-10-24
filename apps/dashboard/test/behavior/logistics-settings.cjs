// Real local Dashboard DOM and React hooks; the fixture substitutes only IPC.
module.exports = async ({win,js,step,settle,click,key,waitFor,assert}) => {
  const textClick = async (text, scope=".logistics-settings, .logistics-editor") => {
    await js(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(scope)})].flatMap(root=>[...root.querySelectorAll('button')]).find(el=>el.textContent===${JSON.stringify(text)}); if(!el || el.disabled) throw new Error('button unavailable: '+${JSON.stringify(text)}); el.focus({preventScroll:true}); el.click(); })()`); await settle();
  };
  const input = async (name,value) => {
    await js(`(() => { const el=document.querySelector('[name="logistics-${name}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`); await settle();
  };
  const select = async (name,value) => {
    await js(`(() => { const el=document.querySelector('[name="logistics-${name}"]'); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await settle();
  };
  const nav = async text => { await js(`[...document.querySelectorAll('.desktop-settings-nav-item')].find(el=>el.textContent.includes(${JSON.stringify(text)})).click()`); await settle(); };
  const editProfile = async name => {
    await js(`(() => { const card=[...document.querySelectorAll('.logistics-card')].find(el=>el.querySelector('h3')?.textContent===${JSON.stringify(name)}); [...card.querySelectorAll('button')].find(el=>el.textContent==='编辑').click(); })()`); await settle();
  };
  const create = async (name,username,password) => {
    await textClick("添加物流商"); await select("provider","tiantai"); await input("name",name);
    assert.equal(await js("Boolean(document.querySelector('[name=logistics-account]'))"),false);
    if(username) await input("username",username); if(password) await input("password",password);
    assert.equal(await js("Boolean(document.querySelector('[name=logistics-store]'))"),false);
    await textClick("保存配置");
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
    assert.equal(await js("document.querySelector('.logistics-editor')?.getAttribute('role')"),'dialog');
    assert.equal(await js("document.querySelector('.logistics-editor')?.parentElement.parentElement===document.body"),true);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-content .logistics-editor'))"),false);
    assert.equal(await js("document.querySelectorAll('.logistics-editor form').length"),0);
    assert.equal(await js("Boolean(document.querySelector('[name=logistics-store]'))"),false);
    assert.equal(await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent==='保存配置').disabled"),true);
    if(process.env.LXE_LOGISTICS_SCREENSHOT) require('node:fs').writeFileSync(process.env.LXE_LOGISTICS_SCREENSHOT.replace(/\.png$/,'-add.png'),(await win.webContents.capturePage()).toPNG());
    await textClick("取消编辑");
    assert.equal(await js("document.activeElement?.textContent"),'添加物流商');
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"),true);
    await textClick('添加物流商');
    await js("document.querySelector('.logistics-editor-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))"); await settle();
    assert.equal(await js("Boolean(document.querySelector('.logistics-editor'))"),false);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"),true);
    await textClick('添加物流商'); await key('Escape');
    assert.equal(await js("Boolean(document.querySelector('.logistics-editor'))"),false);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"),true);
  });
  await step("two Tiantai accounts save separately without closing the settings dialog",async()=>{
    await create("天泰-新棱镜","login-a@example.test","fixture-password-a"); await create("天泰-久艺","login-b","fixture-password-b");
    assert.equal(await js("document.querySelectorAll('.logistics-card').length"),2);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"),true);
    assert.equal((await js("behavior.state().calls")).filter(c=>/saveSetup|restart/.test(c.operation)).length,0);
    assert.match(await js("document.querySelector('.desktop-settings-nav-item[aria-current=page]').textContent"),/已配置 2 条/);
  });
  await step("saved passwords stay blank, survive ordinary edits and can be replaced or cleared",async()=>{
    await editProfile("天泰-新棱镜");
    assert.equal(await js("document.querySelector('[name=logistics-username]').value"),"login-a@example.test");
    assert.equal(await js("Boolean(document.querySelector('[name=logistics-account]'))"),false);
    assert.equal(await js("document.querySelector('[name=logistics-password]').value"),"");
    assert.equal(await js("document.querySelector('[name=logistics-password]').type"),"password");
    await textClick("保存配置"); await waitFor("!document.querySelector('.logistics-editor')","kept password");
    assert.equal(await js("behavior.logistics.state().profiles.find(p=>p.display_name==='天泰-新棱镜').password_configured"),true);
    assert.equal(await js("behavior.logistics.state().profiles.some(p=>Object.hasOwn(p,'password'))"),false);
    await editProfile("天泰-新棱镜"); await input("username","changed-login");
    assert.equal(await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent==='保存配置').disabled"),true);
    await input("password","fixture-replacement"); await textClick("保存配置"); await waitFor("!document.querySelector('.logistics-editor')","replaced credentials");
    await editProfile("天泰-新棱镜"); await textClick("清除已保存密码"); await textClick("保存配置"); await waitFor("!document.querySelector('.logistics-editor')","cleared password");
    assert.equal(await js("behavior.logistics.state().profiles.find(p=>p.display_name==='天泰-新棱镜').password_configured"),false);
    assert.equal(await js("behavior.logistics.state().profiles.find(p=>p.display_name==='天泰-久艺').password_configured"),true);
  });
  await step("draft guards section switching, cancellation, Escape and modal closing",async()=>{
    await editProfile("天泰-新棱镜"); await input("name","未保存草稿");
    await key("Escape");
    await waitFor("document.querySelectorAll('[role=dialog]').length===3","draft confirmation above editor");
    await key("Escape"); assert.equal(await js("document.querySelector('[name=logistics-name]').value"),"未保存草稿");
    assert.equal(await js("document.querySelectorAll('[role=dialog]').length"),2);
    await textClick('取消编辑'); await textClick('确认','.desktop-confirm-dialog');
    assert.equal(await js("Boolean(document.querySelector('.logistics-editor'))"),false);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"),true);
    await editProfile("天泰-新棱镜"); await input("name","未保存草稿"); await nav("ERP 账号");
    await waitFor("document.querySelectorAll('[role=dialog]').length===3","settings navigation guards draft");
    await key("Escape");
    await click(".desktop-close-button"); await textClick("确认",".desktop-confirm-dialog");
    await waitFor("!document.querySelector('.desktop-settings-modal')","confirmed close");
    const readsBefore=(await js("behavior.logistics.calls()")).filter(c=>c.operation==='read').length;
    await click("#open-logistics"); await waitFor("document.querySelectorAll('.logistics-card').length===2","reload saved data");
    assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='read').length,readsBefore+1);
    await editProfile("天泰-新棱镜"); assert.equal(await js("document.querySelector('[name=logistics-name]').value"),"天泰-新棱镜"); await textClick("取消编辑");
  });
  await step("toggle and deletion use independent revisioned actions with confirmation",async()=>{
    await textClick("停用"); await waitFor("document.body.innerText.includes('已停用')","disabled profile"); await textClick("启用");
    await textClick("删除"); assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='delete').length,0);
    await textClick("取消",".desktop-confirm-dialog"); await textClick("删除"); await textClick("确认",".desktop-confirm-dialog");
    await waitFor("document.querySelectorAll('.logistics-card').length===1","delete persisted");
  });
  await step("account profiles reload and save without any store binding or browser status",async()=>{
    const before=(await js("behavior.logistics.calls()")).filter(c=>c.operation==='read').length;
    await textClick("刷新配置");
    assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='read').length,before+1);
    assert.doesNotMatch(await js("document.querySelector('.logistics-card').textContent"),/绑定店铺|店铺未运行|当前未发现|店铺名称冲突|可用/);
    await textClick("编辑");
    assert.equal(await js("Boolean(document.querySelector('[name=logistics-store]'))"),false);
    await textClick("保存配置"); await waitFor("!document.querySelector('.logistics-editor')","account saved independently");
    assert.equal(await js("behavior.logistics.state().profiles.some(p=>Object.hasOwn(p,'store_binding'))"),false);
    assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='refresh').length,0);
  });
  await step("provider fields, duplicate click suppression and revision conflict preserve drafts",async()=>{
    await textClick("添加物流商");
    for(const provider of ['feiwo','yuntuo','jiufang']) {
      await select('provider',provider); assert.equal(await js("Boolean(document.querySelector('[name=logistics-account]'))"),false);
      assert.equal(await js("Boolean(document.querySelector('[name=logistics-store]'))"),false);
      assert.equal(await js("Boolean(document.querySelector('[name=logistics-username]'))"),provider!=='jiufang');
      assert.equal(await js("Boolean(document.querySelector('[name=logistics-password]'))"),provider!=='jiufang');
    }
    await input('name','九方公开'); await js("behavior.logistics.patch({revision:behavior.logistics.state().revision+1})"); await textClick('保存配置');
    await waitFor("document.body.innerText.includes('Revision conflict')","actual conflict"); assert.equal(await js("document.querySelector('[name=logistics-name]').value"),'九方公开');
    assert.match(await js("document.querySelector('.logistics-editor [role=alert]').textContent"),/Revision conflict/);
    await textClick('重新加载','.logistics-editor'); await textClick('保存配置'); assert.match(await js("document.body.innerText"),/Revision conflict/);
    await textClick('取消编辑'); await textClick('确认','.desktop-confirm-dialog'); await textClick('添加物流商'); await select('provider','jiufang'); await input('name','九方公开');
    await js("behavior.logistics.holdSave(true)"); await textClick('保存配置');
    const before=(await js("behavior.logistics.calls()")).filter(c=>c.operation==='save').length;
    await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent==='保存配置').click()"); await settle();
    assert.equal((await js("behavior.logistics.calls()")).filter(c=>c.operation==='save').length,before);
    await key('Escape'); assert.equal(await js("document.querySelector('.logistics-editor')?.getAttribute('aria-busy')"),'true');
    assert.equal(await js("Boolean(document.querySelector('.desktop-confirm-dialog'))"),false);
    await js("behavior.logistics.holdSave(false);behavior.logistics.releaseSave()"); await waitFor("!document.querySelector('.logistics-editor')","held save completed");
    assert.match(await js("document.body.innerText"),/公开接口/);
  });
  await step("configuration errors remain distinct from an empty configuration and retry recovers",async()=>{
    await js("behavior.logistics.failRead(true)"); await textClick('刷新配置'); assert.match(await js("document.body.innerText"),/JSONDecodeError: fixture broken profiles/);
    await js("behavior.logistics.failRead(false)"); await textClick('重新加载'); await waitFor("!document.body.innerText.includes('JSONDecodeError')","retry recovered");
  });
  await step("provider switching in a short viewport keeps the dialog and background stable",async()=>{
    await textClick('刷新配置'); await textClick('添加物流商');
    await input('name','弹窗草稿');
    for (const width of [1200, 680]) {
      win.setSize(width,520); await settle();
      await select('provider','wesa');
      assert.equal(await js("document.querySelector('.logistics-editor-fields').scrollHeight > document.querySelector('.logistics-editor-fields').clientHeight"),true);
      await js("document.querySelector('[name=logistics-provider]').focus()");
      await settle();
      const geometry = () => js("(() => { const content=document.querySelector('.desktop-settings-content'); const editor=document.querySelector('.logistics-editor'); const rect=editor.getBoundingClientRect(); return {scroll:content.scrollTop,top:rect.top,height:rect.height}; })()");
      const before = await geometry();
      for (const provider of ['jiufang','feiwo','tiantai','yuntuo','wesa','jiufang']) {
        await select('provider',provider);
        const after = await geometry();
        assert.ok(Math.abs(after.scroll-before.scroll)<=1,`${width}px ${provider}: scroll position moved`);
        assert.ok(Math.abs(after.top-before.top)<=1,`${width}px ${provider}: dialog jumped`);
        assert.ok(Math.abs(after.height-before.height)<=1,`${width}px ${provider}: editor height changed`);
        assert.equal(await js("document.activeElement?.getAttribute('name')"),'logistics-provider');
        assert.equal(await js("document.querySelector('.logistics-editor-actions').getBoundingClientRect().bottom <= innerHeight"),true);
      }
      await js("[...document.querySelectorAll('.logistics-editor button')].find(el=>el.textContent==='保存配置').focus()");
      await key('Tab'); assert.equal(await js("document.activeElement?.classList.contains('logistics-editor-close')"),true);
      await key('Tab',['shift']); assert.equal(await js("document.activeElement?.textContent"),'保存配置');
      await js("document.querySelector('[name=logistics-name]').focus()"); await key('Enter');
      assert.equal((await js("behavior.state().calls")).filter(c=>c.operation==='saveSetup').length,0);
    }
    await textClick('取消编辑'); await textClick('确认','.desktop-confirm-dialog');
  });
  await step("Chinese and English narrow layouts have no horizontal overflow",async()=>{
    await win.setSize(680,900);
    await editProfile(await js("behavior.logistics.state().profiles.find(p=>p.provider_id==='tiantai').display_name"));
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
