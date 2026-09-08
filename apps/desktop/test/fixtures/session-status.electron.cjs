// Opt-in: start the session-status fixture server, then run this file with Electron.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const url='http://127.0.0.1:5199/test/features/sessions/session-status-fixture.html';
const windows=[];
async function window(){const w=new BrowserWindow({width:1200,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});windows.push(w);w.webContents.on('console-message',event=>console.log('renderer:',event.message));await w.loadURL(url);await delay(900);return w;}
const js=(w,s)=>w.webContents.executeJavaScript(s);
const focus=async w=>{app.focus({steal:true});w.focus();w.webContents.focus();await delay(300);};
const state=(w,id)=>js(w,`(()=>{const row=[...document.querySelectorAll('.session-index-item')].find(e=>e.textContent.startsWith(${JSON.stringify(id+' ·')}));return row?.querySelector('[data-session-state]')?.dataset.sessionState;})()`);
async function expect(w,id,wanted){for(let i=0;i<30;i++){if(await state(w,id)===wanted)return;await delay(100);}console.log(await js(w,`JSON.stringify({focus:document.hasFocus(),state:document.querySelector('#status-state')?.textContent,display:statusFixture.display(),summaries:statusFixture.statuses()})`));throw new Error(`${id}: wanted ${wanted}, got ${await state(w,id)}`);}
const command=(w,operation,input={})=>js(w,`statusFixture.request(${JSON.stringify(operation)},${JSON.stringify(input)})`);
app.whenReady().then(async()=>{try{
 const a=await window();await focus(a);
 await expect(a,'running','running');await expect(a,'stopping','stopping');await expect(a,'queued','queued');await expect(a,'success','completed');await expect(a,'failure','error');await expect(a,'unknown','unknown');await expect(a,'cancelled','cancelled');await expect(a,'idle','idle');
 await js(a,`document.documentElement.dataset.theme='dark'`);await delay(200);fs.writeFileSync(join(tmpdir(),'lxe-session-status-dark.png'),(await a.webContents.capturePage()).toPNG());
 await js(a,`document.documentElement.dataset.theme='light'`);await delay(200);fs.writeFileSync(join(tmpdir(),'lxe-session-status-light.png'),(await a.webContents.capturePage()).toPNG());
 a.webContents.debugger.attach('1.3');await a.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 if(await js(a,`getComputedStyle(document.querySelector('[data-session-state="running"]')).animationName`)!=='none')throw new Error('reduced motion ignored');a.webContents.debugger.detach();
 console.log('PASS all initial states, dark/light, reduced motion');
 const b=await window();await focus(b);
 await js(a,`statusFixture.select('success')`);await delay(700);await expect(a,'success','completed');
 await focus(a);await expect(a,'success','idle');await expect(b,'success','idle');
 console.log('PASS background selection preserves unread; foreground display acknowledges in both windows');
 await js(a,`statusFixture.select('running');statusFixture.show(false)`);await delay(200);
 await command(a,'fixture.transition',{id:'running',turn:'initial-running',state:'completed'});await expect(a,'running','completed');
 await js(a,`statusFixture.show(true)`);await expect(a,'running','idle');
 console.log('PASS other section preserves unread, returning to chat acknowledges loaded result');
 await js(a,`statusFixture.select('idle')`);await delay(200);
 await command(a,'fixture.transition',{id:'idle',turn:'late-result',state:'completed',loaded:false});await expect(a,'idle','completed');await delay(500);await expect(a,'idle','completed');
 await command(a,'fixture.transition',{id:'idle',turn:'late-result',state:'completed'});await focus(a);await expect(a,'idle','idle');
 console.log('PASS terminal notification alone does not acknowledge an unloaded result');
 await js(a,`statusFixture.connect(false)`);await expect(a,'failure','unavailable');await js(a,`statusFixture.connect(true)`);await expect(a,'failure','error');
 await command(a,'fixture.restart');await expect(a,'stopping','unknown');
 a.reload();await delay(900);await focus(a);await expect(a,'failure','error');await expect(a,'success','idle');await expect(a,'stopping','unknown');
 console.log('PASS disconnect/reconnect, SQLite close/reopen, unread and read persistence, orphan recovery');
 await focus(a);await js(a,`statusFixture.select('failure')`);await expect(a,'failure','idle');await expect(b,'failure','idle');
 console.log('PASS failure read clears red in both windows');
 for(const w of windows)w.close();app.exit(0);
}catch(error){console.error(error);for(const w of windows)if(!w.isDestroyed())w.close();app.exit(1);}});
