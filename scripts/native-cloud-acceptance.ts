/** Local mock acceptance for actual company-cloud and model-picker components. No production calls. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, relative } from "node:path";
import { createRequire } from "node:module";
import { DesktopCloudService } from "../apps/desktop/src/main/desktop-cloud";
import { DesktopConfigStore } from "../apps/desktop/src/main/config-store";
import { DesktopCloudEnrollmentManager } from "../apps/desktop/src/main/cloud-enrollment";
import { DesktopCloudContextClient } from "../apps/desktop/src/main/cloud-context";
import { DirectNativeCloudClient } from "../apps/desktop/src/main/native-cloud-client";
import { createLogger } from "../packages/foundation/core/src/logging";

const root=resolve(import.meta.dirname,".."),temporary=mkdtempSync(join(tmpdir(),"native-cloud-page-"));
const artifacts=process.env.LXE_ACCEPTANCE_ARTIFACTS || join(tmpdir(),"lxe-native-cloud-acceptance");
mkdirSync(artifacts,{recursive:true});
let scenario="success",mode="windows-dev";
const device={kind:"managed_device",id:"acceptance",display_name:"DEV-PC-1",wireguard_ip:"10.88.0.28"};
const models=["deepseek-v4-flash","deepseek-v4-pro"];
const calls:string[]=[];
const mock=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  const path=new URL(req.url).pathname;calls.push(path);
  if(req.headers.get("authorization") || req.headers.get("cookie") || req.headers.get("X-LXE-Client")!=="cli")throw Error("Unexpected authentication");
  if(scenario==="offline")return Response.json({detail:{code:"unavailable",message:"mock offline"}},{status:503});
  if(scenario==="denied")return Response.json({detail:{code:"business_device_denied",message:"Device suspended",user_message:"设备已停用"}},{status:403});
  if(path==="/api/v1/device-context")return Response.json({response_schema:"lxe.device-context.v1",device,permission:{
    assignment_version:1,profile:{id:"fba",revision:1,labels:{"zh-CN":"FBA","en-US":"FBA"}},
    grants:{skill_types:["amazon_fba","default"],desktop_features:["erp_dashboard"],server_capabilities:["erp"],erp_actions:["purchase_import"]}}});
  if(path==="/api/v1/device-access")return Response.json({response_schema:"lxe.device-access.v1",device,management_role:"administrator",management_version:1,
    managed_llm_v2:{revision:1,default_target:scenario==="empty"?null:{provider:"deepseek",model:models[0]},
      models:scenario==="empty"?[]:models.map(model=>({provider:"deepseek",model,available:true,credential_revision:"a".repeat(64)}))}});
  if(path.endsWith("/llm-credential"))return Response.json({device,credential:{provider:"deepseek",model:new URL(req.url).searchParams.get("model"),credential_revision:"a".repeat(64),api_key:"mock-only-never-render"}});
  if(path.endsWith("/browser-handoff")){const {target}=await req.json();return Response.json({device,code:(target==="erp"?"lxe_erp_handoff_":"lxe_handoff_")+"x".repeat(43),expires_at:4000000000});}
  throw Error("Unexpected path "+path);
}});
const instances=new Map<string,{cloud:DesktopCloudService,config:DesktopConfigStore}>();
for(const name of ["windows-dev","windows-installed","mac-dev"]){
  const data=join(temporary,name);mkdirSync(data);
  const config=new DesktopConfigStore(data,join(data,"workspace"),{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()},{platform:name==="mac-dev"?"darwin":"win32"});
  const cli=new DesktopCloudContextClient({executablePath:join(root,".venv",process.platform==="win32"?"Scripts/lxeskill.exe":"bin/lxeskill"),cwd:data});
  const native=new DirectNativeCloudClient(),server="http://127.0.0.1:"+mock.port;
  const cloud=new DesktopCloudService({dataRoot:data,config,supported:name!=="windows-dev",
    logger:createLogger("native-acceptance"),enrollments:new DesktopCloudEnrollmentManager(),
    provisioner:{provision:async()=>{throw Error("Unexpected provision");}},onConfigured:async()=>{},
    fetch:Object.assign(async()=>{throw Error("Unexpected credential identity request");},{preconnect:()=>{throw Error("Unexpected identity preconnect");}}),
    contextClient:{query:(_url,signal)=>cli.query(server,signal)},
    accessClient:{request:(_url,path,signal,body)=>native.request(server,path,signal,body)}});
  instances.set(name,{cloud,config});
}
function payload(){
  const {cloud,config}=instances.get(mode)!;
  const list=config.managedLlmState().credentials.map(c=>({provider:c.provider,model:c.model,label:"DeepSeek",credential_source:"cloud",selectable:true,disabled_reason:"",
    model_options:[{model:c.model}]}));
  return {cloud:cloud.state(),models:list,selected:config.managedLlmTarget()?.model || "",mode};
}
const entry=join(temporary,"view.tsx");
writeFileSync(entry,`
import React from ${JSON.stringify(join(root,"apps/dashboard/node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(join(root,"apps/dashboard/node_modules/react-dom/client.js"))};
import {DesktopCloudPanel} from ${JSON.stringify(join(root,"apps/dashboard/src/desktop/shell.tsx"))};
import {ConversationModelPicker} from ${JSON.stringify(join(root,"apps/dashboard/src/features/sessions/view.tsx"))};
import {I18nContext,UI_TEXT} from ${JSON.stringify(join(root,"apps/dashboard/src/shared/i18n.tsx"))};
import ${JSON.stringify(join(root,"apps/dashboard/src/styles.css"))};
function App(){
 const [value,setValue]=React.useState(null),[busy,setBusy]=React.useState(false),[result,setResult]=React.useState("");
 const headingRef=React.useRef(null),lang=new URLSearchParams(location.search).get("lang") || "zh";
 async function run(action){setBusy(true);try{const next=await(await fetch("/"+action,{method:"POST"})).json();setValue(next);return next;}finally{setBusy(false);}}
 React.useEffect(()=>{window.lxe={desktop:{platform:location.search.includes("mac-dev")?"darwin":"win32",clearCloudModelCache:()=>run("clear")}};
 run("refresh");},[]);
 if(!value)return <p>Loading</p>;
 return <I18nContext.Provider value={UI_TEXT[lang]}><main style={{maxWidth:960,margin:"24px auto",padding:20}}>
 <p data-mode>{value.mode}</p>
 <DesktopCloudPanel cloud={value.cloud} activating={busy} enrollment={null} headingRef={headingRef} password="" enrollmentError=""
 onRefreshContext={()=>run("refresh")} onConfirmDevice={()=>run("confirm")} onRetry={()=>run("refresh")}
 onOpenDestination={async target=>{const r=await(await fetch("/open?target="+target,{method:"POST"})).json();setResult(r.result)}}
 onActivate={()=>{}} onPasswordChange={()=>{}} onPrepareDependencies={()=>{}} onSelect={()=>{}} onSwitchBinding={()=>{}}/>
 <output>{result}</output><div style={{marginTop:280,paddingBottom:40}}>
 <ConversationModelPicker models={value.models} current={value.models.find(m=>m.model===value.selected)||null}
 disabled={false} loading={false} saving={busy} onChange={(_p,model)=>run("select?model="+model)}/>
 <output data-selection>{value.selected}</output></div></main></I18nContext.Provider>;
}createRoot(document.getElementById("root")).render(<App/>);`);
const dashboardRequire=createRequire(join(root,"apps/dashboard/package.json"));
const { build: viteBuild } = await import(dashboardRequire.resolve("vite"));
const bundleDirectory=join(temporary,"bundle");
await viteBuild({configFile:false,root:join(root,"apps/dashboard"),logLevel:"warn",
  resolve:{alias:{react:join(root,"apps/dashboard/node_modules/react"),"react-dom":join(root,"apps/dashboard/node_modules/react-dom")}},
  esbuild:{jsx:"automatic"},build:{outDir:bundleDirectory,minify:false,rollupOptions:{input:entry}}});
const outputs=readdirSync(bundleDirectory,{recursive:true}).filter(p=>typeof p==="string" && /\.(js|css|png|svg|ttf|woff2?)$/.test(p)).map(p=>({path:join(bundleDirectory,String(p))}));
const assets=new Map(outputs.map(o=>["/"+relative(bundleDirectory,o.path),o]));
const js=outputs.find(o=>basename(o.path).startsWith("view-") && o.path.endsWith(".js"))!,css=outputs.filter(o=>o.path.endsWith(".css"));
const page=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
 const u=new URL(req.url),{cloud,config}=instances.get(mode)!;
 if(u.pathname==="/scenario"){scenario=u.searchParams.get("value")!;return new Response("ok");}
 if(u.pathname==="/refresh"){await cloud.check();return Response.json(payload());}
 if(u.pathname==="/clear"){await cloud.clearModelCache();return Response.json(payload());}
 if(u.pathname==="/confirm"){await cloud.confirmDevice();return Response.json(payload());}
 if(u.pathname==="/select"){config.saveRuntimePreference("deepseek",u.searchParams.get("model")!,"high","cloud");return Response.json(payload());}
 if(u.pathname==="/open"){
   const target=u.searchParams.get("target");const url=target==="admin_dashboard"?await cloud.adminDashboardUrl():target==="erp_dashboard"?await cloud.erpDashboardUrl():cloud.state().device_context?.server_url+"/dashboard";
   return Response.json({result:new URL(url).pathname}); // Never send the one-time code to the renderer fixture.
 }
 const asset=assets.get(u.pathname);if(asset)return new Response(Bun.file(asset.path));
 if(u.pathname!=="/")return new Response("Not found",{status:404});
 mode=u.searchParams.get("mode")||"windows-dev";
 return new Response('<!doctype html><html><head><meta charset="utf-8">'+css.map(c=>'<link rel="stylesheet" href="/'+relative(bundleDirectory,c.path)+'">').join("")+'</head><body><div id="root"></div><script type="module" src="/'+relative(bundleDirectory,js.path)+'"></script></body></html>',{headers:{"content-type":"text/html"}});
}});
const base="http://127.0.0.1:"+page.port,runner=join(temporary,"runner.cjs");
writeFileSync(runner,`const {app,BrowserWindow,session}=require('electron'),fs=require('fs');
app.setPath('userData',${JSON.stringify(join(temporary,"electron"))});
const base=${JSON.stringify(base)},artifacts=${JSON.stringify(artifacts)};
const wait=async(w,expression)=>{const until=Date.now()+20000;while(Date.now()<until){if(await w.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout '+expression);};
const js=(w,s)=>w.webContents.executeJavaScript(s);
const click=(w,s)=>js(w,'document.querySelector('+JSON.stringify(s)+').click()');
app.whenReady().then(async()=>{try{
 session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith(base+'/') && !d.url.startsWith('data:')}));
 const w=new BrowserWindow({width:1100,height:1000,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 w.webContents.on('console-message',(_e,_level,m)=>{if(m.includes('Error'))console.error(m);});
 for(const mode of ['windows-dev','windows-installed','mac-dev'])for(const lang of ['zh','en']){
  await w.loadURL(base+'/?mode='+mode+'&lang='+lang);
  await wait(w,'document.querySelectorAll(".desktop-cloud-shortcuts-grid button:not(:disabled)").length === 3');
  if(await js(w,'document.body.innerText.includes("mock-only-never-render")'))throw Error('Secret rendered');
  await click(w,'.conversation-model-trigger');
  await wait(w,'document.querySelectorAll("[role=menuitemradio]").length===2');
  await js(w,'Array.from(document.querySelectorAll("[role=menuitemradio]")).find(b=>b.textContent.includes("deepseek-v4-pro")).click()');
  await wait(w,'document.querySelector("[data-selection]").textContent==="deepseek-v4-pro"');
  await click(w,'.desktop-cloud-shortcuts-grid button:nth-child(2)');
  await wait(w,'document.querySelector("output").textContent==="/erp"');
  await click(w,'.desktop-cloud-shortcuts-grid button:nth-child(3)');
  await wait(w,'document.querySelector("output").textContent==="/admin"');
  await js(w,'window.scrollTo(0,0)');
  if(mode==='windows-dev')fs.writeFileSync(artifacts+'/'+mode+'-'+lang+'.png',(await w.webContents.capturePage()).toPNG());
 }
 await w.loadURL(base+'/?mode=windows-dev&lang=zh');await wait(w,'document.querySelectorAll(".desktop-cloud-shortcuts-grid button:not(:disabled)").length===3');
 await js(w,"fetch('/scenario?value=offline')");await click(w,'.device-permission-refresh');
 await wait(w,'document.body.innerText.includes("模型使用缓存")');
 if(await js(w,'document.querySelectorAll(".desktop-cloud-shortcuts-grid button:not(:disabled)").length'))throw Error('Offline login enabled');
 await js(w,"fetch('/scenario?value=denied')");await click(w,'.device-permission-refresh');
 await wait(w,'document.body.innerText.includes("设备访问被拒绝")');
 if(!await js(w,'document.querySelector(".conversation-model-trigger").disabled'))throw Error('Denied models selectable');
 await js(w,"fetch('/scenario?value=success')");await click(w,'.device-permission-refresh');
 await wait(w,'document.body.innerText.includes("云端模型已同步")');
 await js(w,'Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("清除本目录模型缓存")).click()');
 await wait(w,'document.body.innerText.includes("暂无可用云端模型")');
 await click(w,'.device-permission-refresh');await wait(w,'document.body.innerText.includes("云端模型已同步")');
 w.setSize(390,1000);await new Promise(r=>setTimeout(r,200));
 if(await js(w,'document.documentElement.scrollWidth>innerWidth'))throw Error('Narrow overflow');
 fs.writeFileSync(artifacts+'/windows-dev-narrow.png',(await w.webContents.capturePage()).toPNG());
 await js(w,'document.querySelector(".device-permission-refresh").focus()');
 w.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
 await wait(w,'document.activeElement.tagName==="SUMMARY"');
 console.log('PASS native cloud: three launch modes, both languages, model selection, scoped shortcuts, offline, denial, clear/refetch, narrow screen, keyboard');
 w.destroy();app.exit(0);
 }catch(e){console.error(e);app.exit(1);}});
`);
try{
 const require=createRequire(join(root,"apps/desktop/package.json"));
 const env:NodeJS.ProcessEnv={...process.env,NODE_PATH:join(root,"apps/desktop/node_modules")};
 delete env.ELECTRON_RUN_AS_NODE;
 const child=Bun.spawn([require("electron"),runner],{env,stdout:"inherit",stderr:"inherit"});
 if(await child.exited)throw Error("Native cloud UI acceptance failed");
 for(const {config} of instances.values())if(config.cloudConfiguration().managed || config.cloudIdentityCredential())throw Error("Enrollment changed");
 console.log(JSON.stringify({requests:calls.length,artifacts}));
}finally{for(const {cloud} of instances.values())await cloud.stop();mock.stop(true);page.stop(true);rmSync(temporary,{recursive:true,force:true});}
