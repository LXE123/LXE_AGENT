// Run from repository root: bun apps/dashboard/test/features/automations/fixture-server.ts
import { createServer } from "vite";
import { Database } from "bun:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { NodeAutomationStore } from "../../../../desktop/src/main/automation-store";
import { AutomationService } from "../../../../gateway/src/orchestration/automations";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
export async function startAutomationFixture(port = 5212) {
const db = new Database(":memory:");
const store = new NodeAutomationStore(db as unknown as DatabaseSync);
const service = new AutomationService({store,execution:{ready:()=>true,validate:async()=>{},blockReason:async()=>null,submit:async(_run,current)=>current(),observe:async()=>"completed"}});
service.start(); await service.tick();
const first = await service.save({definition:{name:"每日运营简报",prompt:"汇总昨天的运营数据，列出异常变化与需要关注的事项，并把完整报告保存在当前工作区。",timezone:"Asia/Shanghai",schedule:{kind:"rrule",rule:"FREQ=DAILY;BYHOUR=9;BYMINUTE=0",start_at:Date.now()},target:{mode:"new",workspace_id:"workspace"}}});
await service.runNow(first.id);
const paused = await service.save({definition:{name:"补货方案跟进",prompt:"继续整理补货建议。",timezone:"Asia/Shanghai",schedule:{kind:"interval",minutes:60},target:{mode:"reuse",session_id:"chat"}}});
await service.setStatus(paused.id, paused.version, "paused");
const session = {session_id:"chat",title:"补货方案讨论",source_summary:{platform:"desktop"}};
const server=await createServer({root:resolve("apps/dashboard"),server:{host:"127.0.0.1",port,strictPort:true},plugins:[{name:"automation-fixture",configureServer(vite){vite.middlewares.use("/__automations",async(req,res)=>{
  try { let body="";for await(const chunk of req)body+=chunk;const call=parseDashboardRpcCall(JSON.parse(body));let result:unknown;
    switch(call.operation){
      case "automations.list": {
        if (req.url?.includes("expired_once=1")) {
          const future = await service.save({ definition: { name: "过期的一次性任务", prompt: "保留原提示词", timezone: "UTC",
            schedule: { kind: "once", at: Date.now() + 3600_000 }, target: { mode: "reuse", session_id: "chat" } } });
          const paused = await service.setStatus(future.id, future.version, "paused");
          const at = Date.now() - 3600_000;
          store.save({ ...paused, schedule: { kind: "once", at }, next_run_at: at, next_nominal_at: at }, paused.version);
          result = { items: [service.get(future.id)] };
        } else result = { items: service.list() };
        break;
      }
      case "automations.save":result=await service.save(call.input);break;
      case "automations.status":result=await service.setStatus(call.input.id,call.input.version,call.input.status);break;
      case "automations.delete":service.delete(call.input.id,call.input.version);result={deleted:true};break;
      case "automations.run":result=await service.runNow(call.input.id);break;
      case "automations.runs":result={items:await service.runs(call.input.id,call.input.limit)};break;
      case "automations.preview":result=await service.preview(call.input.definition);break;
      case "sessions.list":result={items:[session],total:1};break;
      case "sessions.detail":result={session:{...session,session_id:call.input.session_id}};break;
      case "sessions.workspaces":result={items:[{workspace_id:"workspace",directory:"/Example/运营资料",display_name:"运营资料"}]};break;
      case "models.list":result={items:[]};break;
      default:throw new Error(`Unexpected operation ${call.operation}`);
    }
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(result));
  }catch(error){res.statusCode=400;res.end(String(error));}
});}}]});
await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
return { url: `http://127.0.0.1:${address.port}/test/features/automations/fixture.html`, async stop() { await service.stop(); await server.close(); db.close(); } };
}
if (import.meta.main) {
  const fixture = await startAutomationFixture(); console.log(fixture.url);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void fixture.stop().finally(() => process.exit(0)); });
}
