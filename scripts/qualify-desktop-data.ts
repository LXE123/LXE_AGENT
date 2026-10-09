import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { SqliteRuntimeStore } from "../packages/agent/runtime/src/state/storage";
import { cloneConfig } from "../apps/desktop/src/main/config-store/model";
import { resolveMachineIdentity } from "../packages/foundation/core/src/machine-identity";
import { MIGRATION_CREDENTIAL_ARGUMENT } from "../apps/desktop/src/main/data-credentials";

const [mode,input,submode,install] = process.argv.slice(2);
const q = JSON.parse(readFileSync(input!,"utf8"));
assert.match(q.appId,/^com\.lxe\.agent\.updatequalification\.[a-f0-9]{8}$/);
const source = join(q.installRoot,"var"), target=join(process.env.LOCALAPPDATA!,q.productName);
// Allow SQLite to recover a hot journal from a previous interrupted qualification run.
// These are writable isolated copies, never the original var or production databases.
function checkedDatabase(path: string): Database {
  const db=new Database(path,{create:false,readwrite:true});
  assert.deepEqual(db.query("PRAGMA integrity_check").values(),[["ok"]]);
  return db;
}
if (mode === "run-and-quit") {
  const server=createServer();await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
  const executable=join(install??q.installRoot,q.productName+".exe");
  const child=Bun.spawn([executable,`--inspect=127.0.0.1:${port}`],{stdout:"ignore",stderr:"ignore",env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const evaluate=async(expression:string) => {
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)})).json() as {webSocketDebuggerUrl:string}[];
    assert.ok(targets[0]?.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`));
    const ws=new WebSocket(targets[0]!.webSocketDebuggerUrl);
    try {return await new Promise<any>((done,fail)=>{
      const timer=setTimeout(()=>{ws.close();fail(new Error("Inspector evaluation timed out"));},3000);
      const finish=(error:unknown,value?:unknown)=>{clearTimeout(timer);error?fail(error):done(value);};
      ws.onopen=()=>ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));
      ws.onerror=()=>finish(new Error("Isolated inspector connection failed"));
      ws.onclose=()=>finish(new Error("Isolated inspector disconnected"));
      ws.onmessage=event=>{const response=JSON.parse(String(event.data));if(response.id===1)finish(response.error??response.result?.exceptionDetails,response.result?.result?.value);};
    });} finally {ws.close();}
  };
  let ready=false,lastError:unknown;
  const deadline=Date.now()+180_000;
  try {
    while(Date.now()<deadline){
      try {ready=await evaluate("(()=>{const e=process.mainModule.require('electron');const w=e.BrowserWindow.getAllWindows();return e.app.isReady()&&w.length>0&&w.every(x=>!x.webContents.isLoading());})()");if(ready)break;}catch(error){lastError=error;}
      await Bun.sleep(500);
    }
    assert.ok(ready,`Isolated desktop did not finish loading: ${lastError}`);
    const workspace=await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.lxe.desktop.getSetupState().then(s=>s.workspace_root)')");
    const root=process.env.LXE_DATA_ROOT || target;
    assert.equal(workspace,join(root,"workspace"));
    writeFileSync(join(q.output,process.env.LXE_DATA_ROOT?"explicit-runtime-state.json":"default-runtime-state.json"),JSON.stringify({workspace_root:workspace}));
    await evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true");
    // Bootstrap may have relaunched; wait for the listening main process, not just its parent.
    const quitDeadline=Date.now()+30_000;
    while(Date.now()<quitDeadline){try{await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)});}catch{break;}await Bun.sleep(200);}
    const stillListening=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(()=>true,()=>false);
    assert.equal(stillListening,false,"Isolated desktop did not quit");
    await child.exited;
  } catch(error) {Bun.spawnSync(["taskkill","/PID",String(child.pid),"/T","/F"],{stdout:"ignore",stderr:"ignore"});throw error;}
} else if (mode === "seed") {
  mkdirSync(join(source,"config"),{recursive:true});mkdirSync(join(source,"workspace"),{recursive:true});
  const workspace=join(source,"workspace"), file=join(workspace,"中文 file.txt");
  writeFileSync(file,"preserved workspace data");
  const config=cloneConfig();config.workspace_root=workspace;
  writeFileSync(join(source,"config/settings.json"),JSON.stringify(config));
  writeFileSync(join(source,"config/auth.json"),JSON.stringify({deepseek:{type:"api_key",key:"qualification-local-key"}}));
  const identity=resolveMachineIdentity(join(source,"db/machine_identity.json"));
  writeFileSync(join(q.output,"expected-machine.json"),JSON.stringify(identity));
  const store=new SqliteRuntimeStore(join(source,"db/agent.sqlite3"));await store.start();
  await store.ensureSession({session_id:"migration",source:{},workspace:{directory:workspace,worktree:workspace}});
  await store.appendMessage("migration",{role:"user",content:[{type:"text",text:"迁移测试"},{type:"local_file",attachment_id:"a",turn_id:"t",path:file,name:"中文 file.txt",size_bytes:24,media_type:"text/plain",ts:1}]},"turn_input","t");
  await store.appendArtifact("migration",{artifact_id:"artifact",turn_id:"t",tool_call_id:"call",path:file,name:"中文 file.txt",ts:1});
  await store.stop();
  const gateway=new Database(join(source,"db/gateway.sqlite3"));
  gateway.exec("CREATE TABLE gateway_sessions (session_id TEXT PRIMARY KEY, source TEXT DEFAULT '{}', workspace_directory TEXT, workspace_worktree TEXT, created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '')");
  gateway.query("INSERT INTO gateway_sessions(session_id, workspace_directory, workspace_worktree) VALUES(?,?,?)").run("migration",workspace,workspace);gateway.close();
  const python=new Database(join(source,"db/lxeskill.sqlite3"));
  python.exec("CREATE TABLE ziniao_store_sessions (host_id TEXT NOT NULL, browser_oauth TEXT NOT NULL, browser_id INTEGER NOT NULL, browser_name TEXT DEFAULT '', debugging_port INTEGER DEFAULT 0, download_path TEXT DEFAULT '', browser_path TEXT DEFAULT '', core_type TEXT DEFAULT '', core_version TEXT DEFAULT '', created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', PRIMARY KEY(host_id,browser_oauth))");
  python.query("INSERT INTO ziniao_store_sessions(host_id,browser_oauth,browser_id,download_path,browser_path) VALUES('qualification','fake',1,?,?)").run(join(source,"downloads"),"C:\\external-browser");python.close();
} else if(mode === "probe-credentials") {
  const failure=JSON.parse(readFileSync(target+".migration-error.json","utf8"));
  assert.ok(failure.stage.startsWith(target+".migrating-"));
  const desktop=createRequire(resolve("apps/desktop/package.json"));
  const result=Bun.spawnSync([desktop("electron") as string,resolve("apps/desktop/dist/main.js"),MIGRATION_CREDENTIAL_ARGUMENT+failure.stage],{stdout:"pipe",stderr:"pipe",timeout:90_000,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  assert.equal(result.exitCode,0,result.stderr.toString());
  writeFileSync(join(q.output,"credential-probe-results.json"),JSON.stringify({copied_profile_decrypts:true}));
} else if (mode === "native") {
  const build=await Bun.build({entrypoints:[resolve("scripts/qualify-desktop-data-electron.ts")],outdir:q.output,target:"node",format:"cjs",external:["electron"]});
  if(!build.success)throw new AggregateError(build.logs,"Native migration probe build failed");
  const desktop=createRequire(resolve("apps/desktop/package.json"));
  const electron=desktop("electron") as string;
  const result=Bun.spawnSync([electron,build.outputs[0]!.path,`--qualification=${resolve(input!)}`,`--mode=${submode}`,`--install=${install??q.installRoot}`],{stdout:"pipe",stderr:"pipe",timeout:180_000,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,LXE_DATA_ROOT:undefined}});
  if(result.exitCode!==0)throw new Error(`Electron probe ${submode} exited ${result.exitCode}: ${result.stderr.toString()}`);
} else if(mode === "check-explicit") {
  const independent=join(q.output,"independent data 中文");
  assert.equal(JSON.parse(readFileSync(join(q.output,"explicit-runtime-state.json"),"utf8")).workspace_root,join(independent,"workspace"));
  assert.ok(existsSync(join(independent,"config/settings.json")));
  assert.equal(existsSync(join(independent,"workspace/中文 file.txt")),false);
  // A fresh setup creates its machine identity and Agent DB only when those services start.
  const identity=join(independent,"db/machine_identity.json");
  if(existsSync(identity))assert.notDeepEqual(JSON.parse(readFileSync(identity,"utf8")),JSON.parse(readFileSync(join(q.output,"expected-machine.json"),"utf8")));
  const database=join(independent,"db/agent.sqlite3");
  if(existsSync(database)){
    const db=checkedDatabase(database);
    assert.equal((db.query("SELECT COUNT(*) AS n FROM agent_sessions WHERE session_id='migration'").get() as any).n,0);db.close();
  }
  writeFileSync(join(q.output,"data-explicit-results.json"),JSON.stringify({explicit_root:true,no_automatic_import:true,no_imported_identity:true}));
} else if(mode === "check") {
  assert.deepEqual(JSON.parse(readFileSync(join(target,"db/machine_identity.json"),"utf8")),JSON.parse(readFileSync(join(q.output,"expected-machine.json"),"utf8")));
  assert.equal(readFileSync(join(target,"workspace/中文 file.txt"),"utf8"),"preserved workspace data");
  const db=checkedDatabase(join(target,"db/agent.sqlite3"));
  assert.equal((db.query("SELECT workspace_directory FROM agent_sessions WHERE session_id='migration'").get() as any).workspace_directory,join(target,"workspace"));
  for(const table of ["transcript_attachments","transcript_artifacts"]){assert.equal((db.query(`SELECT path FROM ${table} LIMIT 1`).get() as any).path,join(target,"workspace/中文 file.txt"));}db.close();
  const gateway=checkedDatabase(join(target,"db/gateway.sqlite3"));
  assert.equal((gateway.query("SELECT workspace_directory FROM gateway_sessions").get() as any).workspace_directory,join(target,"workspace"));gateway.close();
  const python=checkedDatabase(join(target,"db/lxeskill/lxeskill.sqlite3"));
  assert.equal((python.query("SELECT download_path FROM ziniao_store_sessions").get() as any).download_path,join(target,"downloads"));python.close();
  const store=new SqliteRuntimeStore(join(target,"db/agent.sqlite3"));await store.start();
  try {
    assert.ok(JSON.stringify(await store.loadMessages("migration")).includes("迁移测试"));
    for(const item of [await store.resolveAttachment("migration","a"),await store.resolveArtifact("migration","artifact")]){
      assert.equal(item?.path,join(target,"workspace/中文 file.txt"));
      assert.equal(readFileSync(item!.path,"utf8"),"preserved workspace data");
    }
  } finally {await store.stop();}
  writeFileSync(join(q.output,"data-content-results.json"),JSON.stringify({machine:true,workspace:true,sessions:true,attachments:true,artifacts:true,gateway:true,python:true}));
} else throw new Error(`Unknown qualification operation: ${mode}`);
console.log(`PASS isolated data qualification ${mode} ${submode??""}`);
