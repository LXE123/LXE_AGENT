const {app,BrowserWindow,protocol,session,nativeImage}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const [profile,output]=process.argv.slice(2),passed=[];
app.disableHardwareAcceleration();app.setPath('userData',profile);
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=require(path.join(output,'main','host.cjs'));
 host.registerDashboardProtocol(output);
 session.defaultSession.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[host.DASHBOARD_CSP]}}));
 const options={width:1100,height:740,show:true,webPreferences:{preload:path.join(output,'main','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}};
 const win=new BrowserWindow(options),js=code=>win.webContents.executeJavaScript(code);
 const tools=new host.ManualToolsService(()=>win,output,async()=>profile);tools.register();
 const visibleBrowser=()=>win.contentView.children.some(view=>view.webContents&&view.webContents!==win.webContents&&view.getVisible());
 const dispose=host.registerDesktopIpc({isTrustedFileSender:event=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame});
 const wait=async(condition,label)=>{for(let i=0;i<160;i++){if(await js(condition))return;await delay(50);}throw new Error('Timeout '+label+'\n'+await js('document.body.innerText'));};
 const click=async(selector)=>{await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(100);};
 const step=async(name,fn)=>{await fn();passed.push(name);console.log('PASS '+name);};
 let other;
 try{
  await win.loadURL('app://lxe/test/features/workspace-apps/renderer.html');
  await wait("document.querySelectorAll('.workspace-open-split').length===3",'three controls');
  await step('Default and successful selection synchronize across both headers and the file tree',async()=>{
   assert.equal(await js("document.querySelectorAll('.workspace-open-split button[aria-label*=Finder]').length"),3);
   await click('#new .workspace-open-split button:last-child');await wait("document.querySelectorAll('[role=menuitem]').length===3",'menu');
   await click('[role=menuitem]:nth-child(2)');
   await wait("document.querySelectorAll('.workspace-open-split button[aria-label*=Code]').length===3",'shared selection');
   assert.deepEqual(await js('fixture.calls.find(c=>c.directory)'),{directory:'/first',id:'vscode'});
   assert.equal(await js("localStorage.getItem('lxe.workspace-open.application.v1')"),'vscode');
   assert.equal(await js("document.querySelectorAll('.conversation-workspace-label').length"),1);
  });
  await step('Popup keyboard navigation, focus return and browser occlusion',async()=>{
   assert.equal(visibleBrowser(),true,'native browser visible before menu');
   await click('#existing .workspace-open-split button:last-child');
   await wait("fixture.calls.some(c=>c.operation==='browser.present'&&c.input.bounds===null)",'browser hidden behind menu');
   await js("document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
   assert.equal(visibleBrowser(),false,'native browser hidden by menu');
   assert.ok(await js("document.activeElement.textContent.includes('终端')"));
   await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
   assert.equal(await js("document.activeElement===document.querySelector('#existing .workspace-open-split button:last-child')"),true);
   assert.equal(await js("!!document.querySelector('[role=menu]')"),false);
  });
  await step('Launch errors preserve actual diagnostics and previous preference',async()=>{
   await js("fixture.fail('EACCES: native launcher fixture')");await click('#new .workspace-open-split button:last-child');await click('[role=menuitem]:last-child');
   await wait("document.querySelector('[role=alert]')?.textContent.includes('EACCES: native launcher fixture')",'actual error');
   assert.equal(await js("localStorage.getItem('lxe.workspace-open.application.v1')"),'vscode');
   await js("fixture.fail('');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  });
  await step('In-flight opening captures the old path without stealing navigation',async()=>{
   await js('fixture.hold(true)');await click('#existing .workspace-open-split button:first-child');
   assert.equal(await js("document.querySelectorAll('.workspace-open-split button:not(:disabled)').length"),0);
   await js("fixture.setPath('/second');fixture.release();fixture.hold(false)");await delay(100);
   assert.equal(await js('fixture.calls.filter(c=>c.directory).at(-1).directory'),'/first');
   assert.equal(await js("document.querySelector('#new select').value"),'workspace:/second');
  });
  await step('Reload restores preference, query retry works, missing preferred app falls back',async()=>{
   await win.reload();await wait("document.querySelectorAll('.workspace-open-split button[aria-label*=Code]').length===3",'persisted choice');
   await js("fixture.query('registry denied fixture')");await click('#new .workspace-open-split button:last-child');
   assert.ok(await js("document.querySelector('[role=alert]').textContent.includes('registry denied fixture')"));
   await click('[role=menuitem]');assert.equal(await js('fixture.calls.filter(c=>c.directory).at(-1).id'),undefined);
   await js("fixture.query('');fixture.apps([{id:'finder',name:'Finder',icon:null}])");
   await wait("document.querySelectorAll('.workspace-open-split button').length===3",'single app hides arrow');
  });
  await step('Light/dark narrow menus stay on screen',async()=>{
   await js("fixture.apps([{id:'finder',name:'Finder',icon:null},{id:'vscode',name:'VS Code '+ 'long '.repeat(30),icon:null}])");
   for(const theme of ['light','dark']){
    await js(`document.documentElement.dataset.theme='${theme}';document.getElementById('root').style.width='420px'`);
    await click('#new .workspace-open-split button:last-child');
    assert.ok(await js("(()=>{const r=document.querySelector('[role=menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"));
    if(process.env.LXE_WORKSPACE_SCREENSHOT){fs.mkdirSync(process.env.LXE_WORKSPACE_SCREENSHOT,{recursive:true});fs.writeFileSync(path.join(process.env.LXE_WORKSPACE_SCREENSHOT,theme+'.png'),(await win.webContents.capturePage()).toPNG());}
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
   }
  });
  await step('Real Electron application discovery and icons via the production IPC',async()=>{
   const apps=await js('fixture.native.desktop.getWorkspaceApplications()');
   assert.ok(apps.some(a=>a.id===(process.platform==='darwin'?'finder':'explorer')));assert.ok(apps.every(a=>!a.icon||a.icon.startsWith('data:image/')));
   console.log('NATIVE_APPS='+JSON.stringify(apps.map(a=>({id:a.id,icon:!!a.icon}))));
   if(process.platform==='darwin'){
    const known=apps.filter(a=>['finder','vscode','terminal'].includes(a.id));
    const pixels=known.map(a=>{assert.ok(a.icon,a.id+' has an icon');const image=nativeImage.createFromDataURL(a.icon);assert.equal(image.isEmpty(),false,a.id+' decodes');return image.toBitmap().toString('base64');});
    assert.equal(new Set(pixels).size,known.length,'Finder, VS Code and Terminal must have distinct application icons, not the same generic bundle icon');
   }
   await js(`fixture.apps(${JSON.stringify(apps)})`);
   for(const theme of apps.length>1?['light','dark']:[]){
    await js(`document.documentElement.dataset.theme='${theme}'`);
    await click('#new .workspace-open-split button:last-child');
    await wait(`document.querySelectorAll('.workspace-open-menu img').length===${apps.filter(a=>a.icon).length} && [...document.querySelectorAll('.workspace-open-menu img')].every(img=>img.complete&&img.naturalWidth>0)`,'real icons render');
    if(process.env.LXE_WORKSPACE_SCREENSHOT)fs.writeFileSync(path.join(process.env.LXE_WORKSPACE_SCREENSHOT,'native-icons-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
   }
   if(process.env.LXE_WORKSPACE_NATIVE_OPEN){
    const folder=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'lxe-open-中文 & '));console.log('NATIVE_FOLDER='+folder);
    const ids=[process.platform==='darwin'?'finder':'explorer','vscode',...(process.platform==='darwin'?['terminal']:['windowsterminal','gitbash'])].filter(id=>apps.some(a=>a.id===id));
    for(const id of ids){await js(`fixture.native.desktop.openWorkspace(${JSON.stringify(folder)},${JSON.stringify(id)})`);console.log('NATIVE_OPEN='+id);}
   }
  });
  await step('Untrusted renderer cannot query or launch applications',async()=>{
   other=new BrowserWindow({...options,show:false});await other.loadURL('app://lxe/test/features/workspace-apps/renderer.html');
   const result=await other.webContents.executeJavaScript("native.desktop.getWorkspaceApplications().then(()=>'',e=>e.message)");assert.match(result,/only available to the desktop main frame/);
   const opened=await other.webContents.executeJavaScript("native.desktop.openWorkspace('/tmp').then(()=>'',e=>e.message)");assert.match(opened,/only available to the desktop main frame/);
  });
  console.log('LXE_WORKSPACE_RESULT='+JSON.stringify({passed}));
 }catch(error){console.error(error);process.exitCode=1;}
 finally{dispose();await tools.stop();other?.destroy();win.destroy();app.exit(process.exitCode||0);}
});
