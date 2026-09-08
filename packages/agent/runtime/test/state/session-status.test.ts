import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStatusStore } from "../../src/state/session-status-store";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { testWorkspace } from "../workspace";
import type { SessionRunPhase } from "@lxe/protocol/session-status";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(){const root=mkdtempSync(join(tmpdir(),"lxe-session-status-"));roots.push(root);const path=join(root,"agent.sqlite3");const db=new Database(path);SessionStatusStore.migrate(db);const store=new SessionStatusStore(db);store.request({action:"reconcile",owner:"boot",live:[]});let sequence=0;
  return {path,db,store,update:(turn_id:string,state:SessionRunPhase)=>store.request({action:"apply",owner:"boot",updates:[{session_id:"s",turn_id,state,event_version:++sequence}]}),get:()=>store.request({action:"list",session_ids:["s"]})[0]!};}
test("terminal notifications and exact result acknowledgements survive SQLite reopen",()=>{
  const f=setup();f.update("a","queued");f.update("a","running");expect(f.get().state).toBe("running");f.update("a","completed");const old=f.get();f.db.close();
  const db=new Database(f.path);const store=new SessionStatusStore(db);expect(store.request({action:"list",session_ids:["s"]})[0]).toEqual(old);
  store.request({action:"ack",session_id:"s",turn_id:"a",version:old.result!.version});db.close();
  const restored=new Database(f.path);expect(new SessionStatusStore(restored).request({action:"list",session_ids:["s"]})[0]!.state).toBe("idle");restored.close();
});
test("busy priority, unread failures, cancelled queue and acknowledgement race",()=>{
  const f=setup();f.update("a","error");const a=f.get().result!;f.update("b","queued");expect(f.get().state).toBe("queued");f.update("b","running");f.update("c","queued");f.update("c","cancelled");expect(f.get().state).toBe("running");
  f.update("b","completed");expect(f.get().result?.turn_id).toBe("a");f.store.request({action:"ack",session_id:"s",turn_id:"a",version:a.version+1});expect(f.get().state).toBe("error");
  f.store.request({action:"ack",session_id:"s",turn_id:"a",version:a.version});expect(f.get().result?.turn_id).toBe("b");f.db.close();
});
test("duplicate terminal and old running events cannot regress or recreate unread results",()=>{
  const f=setup();f.update("a","running");f.update("a","completed");const done=f.get();f.update("a","completed");f.update("a","running");expect(f.get()).toEqual(done);
  f.store.request({action:"ack",session_id:"s",turn_id:"a",version:done.result!.version});f.update("a","error");expect(f.get().state).toBe("idle");f.db.close();
});
test("restart reconciles real active tasks; missing tasks become unknown, never success",()=>{
  const f=setup();f.update("a","running");f.update("b","queued");
  f.store.request({action:"reconcile",owner:"next",live:[{session_id:"s",turn_id:"a",state:"running",event_version:10}]});expect(f.get().state).toBe("running");
  f.store.request({action:"apply",owner:"next",updates:[{session_id:"s",turn_id:"a",state:"completed",event_version:11}]});expect(f.get().state).toBe("unknown");
  f.update("b","running");expect(f.get().state).toBe("unknown");f.db.close();
});
test("empty installation has no historical unread and deletion cleans status tables",async()=>{
  const root=mkdtempSync(join(tmpdir(),"lxe-session-status-delete-"));roots.push(root);const store=new SqliteRuntimeStore(join(root,"agent.sqlite3"));await store.start();
  await store.ensureSession({session_id:"s",workspace:testWorkspace,source:{}});expect(store.sessionStatus({action:"list",session_ids:["s"]})[0]!.state).toBe("idle");
  store.sessionStatus({action:"reconcile",owner:"boot",live:[]});store.sessionStatus({action:"apply",owner:"boot",updates:[{session_id:"s",turn_id:"a",state:"error",event_version:1}]});
  await store.deleteSession("s");expect(store.sessionStatus({action:"list",session_ids:["s"]})[0]).toEqual({session_id:"s",version:0,state:"idle"});await store.stop();
});
