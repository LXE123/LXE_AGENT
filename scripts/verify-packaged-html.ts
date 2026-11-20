/** Starts the actual packaged app with isolated test state; no model calls or external browser automation. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Usage on Windows: bun scripts/verify-packaged-html.ts <win-unpacked-directory>');
const source = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'lxe-packaged-html-'));
const dataRoot = mkdtempSync(join(tmpdir(), 'lxe-packaged-html-data-'));
// Keep the original package and its var directory untouched; use its exact resources.
for (const entry of readdirSync(source, {withFileTypes:true})) {
  if (entry.isFile() || entry.name === 'locales') cpSync(join(source, entry.name), join(root, entry.name), {recursive:true});
}
symlinkSync(join(source, 'resources'), join(root, 'resources'), 'junction');
const workspace = join(root, 'workspace 中文'); mkdirSync(workspace);
writeFileSync(join(workspace, 'report.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><h1 id="title">打包后的 HTML</h1><button id="count" onclick="this.textContent=String(++window.count)">0</button><script>window.count=0</script><script src="script.js"></script>');
writeFileSync(join(workspace, 'style.css'), 'h1{color:rgb(12,34,56)}');
writeFileSync(join(workspace, 'script.js'), "window.packagedScript=true");
const env = {...process.env, LXE_DATA_ROOT: dataRoot}; delete env.ELECTRON_RUN_AS_NODE;
const child = Bun.spawn([join(root, 'LXE Agent.exe'), '--inspect=127.0.0.1:0', '--disable-gpu'], {env, stdout:'pipe', stderr:'pipe'});
let logs = '', debuggerAddress: string | undefined;
const collect = async (stream: ReadableStream<Uint8Array>) => {for await(const chunk of stream) { logs += new TextDecoder().decode(chunk); debuggerAddress ??= logs.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z\d-]+/)?.[0]; }};
void collect(child.stdout); void collect(child.stderr);
const delay = (ms: number) => new Promise(r=>setTimeout(r,ms));
async function wait(fn:()=>unknown|Promise<unknown>, label:string) {const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await delay(100)}throw new Error('Timed out: '+label)}
let socket: WebSocket | undefined, sequence=0;
const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:any)=>void}>();
async function raw(expression: string):Promise<any> {
  const id=++sequence;
  const result=new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.delete(id))reject(new Error('Inspector request timed out'))},15000)});
  socket!.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));return result;
}
async function evaluate(expression: string):Promise<any> {
  const job=++sequence;
  await raw(`globalThis.__htmlJobs ||= {}; globalThis.__htmlJobs[${job}]={done:false};Promise.resolve((${expression})).then(value=>globalThis.__htmlJobs[${job}]={done:true,value},error=>globalThis.__htmlJobs[${job}]={done:true,error:String(error)});true`);
  let result:any;
  await wait(async()=>{result=await raw(`globalThis.__htmlJobs[${job}]`);return result?.done},'evaluation '+job);
  if(result.error)throw new Error(result.error);return result.value;
}
const renderer = (code:string) => evaluate(`htmlTestElectron.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(code)})`);
try {
  await wait(()=>debuggerAddress,'packaged app inspector');
  socket=new WebSocket(debuggerAddress!); await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject});
  socket.onmessage=event=>{const message=JSON.parse(String(event.data)), task=pending.get(message.id);if(!task)return;pending.delete(message.id);if(message.error||message.result?.exceptionDetails)task.reject(new Error(JSON.stringify(message.error||message.result.exceptionDetails)));else task.resolve(message.result?.result?.value)};
  await delay(2000);
  await evaluate("(globalThis.htmlTestElectron=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron'),true)");
  await wait(()=>evaluate("htmlTestElectron.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().startsWith('app://lxe/'))"),'production dashboard');
  await wait(()=>renderer('!!window.lxe?.files && !!window.lxe?.dashboard'),'production preload');
  const registration=await renderer(`window.lxe.dashboard.call({operation:'workspaces.register',input:{directory:${JSON.stringify(workspace)}}})`);
  const created=await renderer(`window.lxe.dashboard.call({operation:'sessions.create',input:{workspace_id:${JSON.stringify(registration.workspace_id)}}})`);
  const sessionId=created.id||created.session_id; assert.ok(sessionId, JSON.stringify(created));
  const ref={session_id:sessionId,kind:'workspace',path:'report.html'};
  const preview=await renderer(`window.lxe.files.call({operation:'prepare',input:{ref:${JSON.stringify(ref)},request_id:'packaged-html-test'}})`);
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const prepared=await renderer(`window.lxe.files.call({operation:'html.prepare',input:{handle:${JSON.stringify(preview.value.handle)},references:[{kind:'stylesheet',reference:'style.css'},{kind:'script',reference:'script.js'}]}})`);
  assert.equal(prepared.ok,true,JSON.stringify(prepared));
  await renderer(`document.body.replaceChildren();var iframe=document.createElement('iframe');iframe.sandbox='allow-scripts';iframe.src=${JSON.stringify(prepared.value.url)};iframe.style='width:95vw;height:85vh;border:0';document.body.append(iframe);true`);
  const frameCode=(code:string)=>evaluate(`htmlTestElectron.BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('lxe-preview:')).executeJavaScript(${JSON.stringify(code)})`);
  await wait(async()=>{try{return await frameCode('window.packagedScript===true')}catch{return false}},'packaged HTML scripts');
  assert.equal(await frameCode("document.querySelector('#title').textContent"),'打包后的 HTML');
  assert.equal(await frameCode("getComputedStyle(document.querySelector('#title')).color"),'rgb(12, 34, 56)');
  await frameCode("document.querySelector('#count').click()");assert.equal(await frameCode('window.count'),1);
  assert.deepEqual(await frameCode("(()=>{let blocked=false;try{parent.document.body}catch{blocked=true}return [blocked,typeof window.lxe,typeof process,typeof require]})()"),[true,'undefined','undefined','undefined']);
  await evaluate(`htmlTestElectron.BrowserWindow.getAllWindows()[0].webContents.capturePage().then(image=>process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(join(root,'preview.png'))},image.toPNG())).then(()=>true)`);
  await renderer("document.body.replaceChildren();window.lxe.files.call({operation:'release',input:{request_id:'packaged-html-test'}})");
  await renderer(`window.lxe.dashboard.call({operation:'sessions.delete',input:{session_id:${JSON.stringify(sessionId)}}})`);
  await renderer(`window.lxe.dashboard.call({operation:'workspaces.delete',input:{workspace_id:${JSON.stringify(registration.workspace_id)}}})`);
  const report={packaged:await evaluate('htmlTestElectron.app.isPackaged'),platform:process.platform,source,root,passed:['actual packaged executable','production app:// dashboard/preload/CSP','Runtime-owned empty session','HTML and relative CSS/JS from packaged file service','Unicode paths','interactive script','opaque frame without IPC/Node','release and session deletion']};
  assert.equal(report.packaged,true);writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log('LXE_PACKAGED_HTML_RESULT='+JSON.stringify(report));
  await evaluate('(setTimeout(()=>htmlTestElectron.app.quit(),100),true)'); socket.close();
  await Promise.race([child.exited,delay(15000).then(()=>{throw new Error('Packaged app did not quit')})]);
} catch(error) {writeFileSync(join(root,'failure.log'),logs);console.error('Packaged test directory: '+root);throw error}
finally {socket?.close();if(child.exitCode===null){child.kill();await child.exited}}
