import { expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import type { AgentJob } from "@lxe/protocol";
import type { SessionStatusSnapshot } from "@lxe/desktop-protocol";
import { SessionStatusStore } from "../../../../packages/agent/runtime/src/state/session-status-store";
import { SessionStatusCoordinator } from "../../src/orchestration/session-status";
import { SessionScheduler } from "../../src/orchestration/scheduler";
const job=(id:string):AgentJob=>({job_id:id,user_id:"fixture",conversation_id:"s",is_group:false,job_kind:"turn",sender_nick:"fixture",raw_data:{},session_id:"s",session_key:"desktop:s",response_route_id:`route:${id}`,message_id:id,user_input:"fixture",user_content_blocks:[],diagnostics:[],source:{platform:"desktop",chat_id:"s",chat_type:"dm",user_id:"fixture"},workspace:{directory:"/tmp",worktree:"/tmp"}});
function setup(){const db=new Database(":memory:");SessionStatusStore.migrate(db);const store=new SessionStatusStore(db);const events:SessionStatusSnapshot[]=[];const errors:Error[]=[];let failed=false;let rejectCancel=false;let cancelGate:Promise<void>|undefined;
  const status=new SessionStatusCoordinator({request:async r=>{if(failed)throw new Error("fixture SQLITE_FULL");return store.request(r);},live:()=>scheduler.runStatuses(),publish:e=>events.push(e),onError:e=>errors.push(e)});
  const scheduler=new SessionScheduler({runtime:{startTurn:async()=>{},cancelTurn:async()=>{await cancelGate;if(rejectCancel)throw new Error("fixture cancel rejected");},steerTurn:async()=>{}},onJobState:e=>status.event(e)});
  status.setReady(true);return {db,store,status,scheduler,events,errors,holdCancel:()=>{let release!:()=>void;cancelGate=new Promise<void>(resolve=>{release=resolve;});return release;},fail:()=>{failed=true;},recover:()=>{failed=false;},rejectCancel:()=>{rejectCancel=true;},done:(id:string,state="completed")=>scheduler.handleRuntimeEvent({kind:"runtime.turn.completed",run_id:id,payload:{session_id:"s",job_id:id,status:state}})};}
test("all scheduler jobs including auto-wakes are tracked; queued successor never flashes completion",async()=>{
  const f=setup();await f.scheduler.enqueue(job("external"));await f.scheduler.enqueue(job("wake"));await f.status.flush();expect((await f.status.list(["s"])).items[0]!.state).toBe("running");
  const start=f.events.length;f.done("external");await f.status.flush();expect(f.events.slice(start).every(e=>e.items.every(i=>i.state==="running"))).toBe(true);
  expect(f.done("external")).toBe(false);expect(f.scheduler.handleRuntimeEvent({kind:"stream.final",run_id:"wake",payload:{}})).toBe(false);
  await f.status.flush();expect((await f.status.list(["s"])).items[0]!.state).toBe("running");f.done("wake");await f.status.flush();expect((await f.status.list(["s"])).items[0]!.state).toBe("completed");await f.status.stop();f.db.close();
});
test("stopping remains busy, cancel rejection restores running, confirmed cancellation is neutral",async()=>{
  const f=setup();await f.scheduler.enqueue(job("a"));await f.status.flush();f.rejectCancel();await expect(f.scheduler.requestStop("s")).rejects.toThrow("fixture cancel rejected");await f.status.flush();expect((await f.status.list(["s"])).items[0]!.state).toBe("running");
  f.done("a","cancelled");await f.status.flush();expect((await f.status.list(["s"])).items[0]!.state).toBe("cancelled");await f.status.stop();f.db.close();
});
test("SQLite failure reports the actual error and never prevents dispatch; retry restores durable result",async()=>{
  const f=setup();await f.status.flush();f.fail();await f.scheduler.enqueue(job("a"));await expect(f.status.flush()).rejects.toThrow("fixture SQLITE_FULL");expect(f.scheduler.hasInflightWork("s")).toBe(true);expect(f.events.at(-1)!.items[0]!.error).toBe("fixture SQLITE_FULL");
  f.done("a","error");f.recover();await f.status.flush();expect((await f.status.list(["s"])).items[0]!.state).toBe("error");await f.status.stop();f.db.close();
});
test("accepted cancellation stays stopping until the scheduler receives the terminal event", async () => {
  const f = setup();
  await f.scheduler.enqueue(job("a"));
  await f.status.flush();
  const release = f.holdCancel();
  const stopped = f.scheduler.requestStop("s");
  await f.status.flush();
  expect((await f.status.list(["s"])).items[0]!.state).toBe("stopping");
  release(); await stopped;
  expect((await f.status.list(["s"])).items[0]!.state).toBe("stopping");
  f.done("a", "cancelled");
  await f.status.flush();
  expect((await f.status.list(["s"])).items[0]!.state).toBe("cancelled");
  await f.status.stop(); f.db.close();
});
