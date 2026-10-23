import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { AgentJob } from "@lxe/protocol";
import { resolveWorkspaceContext } from "@lxe/core";
import { DesktopAutomations } from "../src/main/automations";
import { NodeAutomationStore } from "../src/main/automation-store";
import { requestDesktopPipe, startDesktopPipe, encodePipeFrame } from "../src/mcp/pipe";
import { takeDesktopMcpConfig } from "../../agent-cli/src/desktop-mcp";
import { McpManager, OfficialMcpConnector } from "../../../packages/agent/runtime/src/tooling/mcp";
import { ToolRegistry } from "../../../packages/agent/runtime/src/tooling/registry";
import { TypeScriptAgentRuntime } from "../../../packages/agent/runtime/src/engine/runtime";
import { SqliteRuntimeStore } from "../../../packages/agent/runtime/src/state/storage";
import { PermissionPolicyService } from "../../../packages/agent/runtime/src/permissions/policy";
import { messageFixture } from "../../../packages/agent/runtime/test/message-fixtures";

const eventually = async (test: () => boolean) => { const end = Date.now()+3000; while (!test() && Date.now()<end) await Bun.sleep(10); expect(test()).toBe(true); };

test("real Runtime -> managed MCP stdio -> authenticated desktop pipe -> persisted schedule, with caller isolation", async () => {
  const root = mkdtempSync(join(tmpdir(),"lxe-desktop-mcp-")), workspace = resolveWorkspaceContext(root);
  const db = new Database(join(root,"gateway.sqlite3"));
  const environment: Record<string,string|undefined> = {};
  let active = true;
  const app = new DesktopAutomations({ store: new NodeAutomationStore(db as unknown as DatabaseSync), environment,
    node: process.execPath, script: join(import.meta.dir,"../src/mcp/server.ts"), changed() {}, onError(error) { throw error; },
    runtime: { isReady:true, dashboardCall: async (call: {operation:string}) => {
      if (call.operation === "sessions.workspaces") return {items:[{workspace_id:"ws",directory:root}]};
      if (call.operation === "sessions.detail") return {session:{source_summary:{platform:"desktop"}}};
      throw new Error(`unexpected RPC ${call.operation}`);
    } } as unknown as ConstructorParameters<typeof DesktopAutomations>[0]["runtime"],
    composition: { parts:{scheduler:{isSessionDeletionFenced:()=>false,activeRun:()=> active ? {jobId:"t1", originJob:{source:{platform:"desktop"}},cancelled:false} : undefined}} } as unknown as ConstructorParameters<typeof DesktopAutomations>[0]["composition"],
  });
  await app.openPipe();
  const pipe = environment.LXE_DESKTOP_MCP_PIPE!, token = environment.LXE_DESKTOP_MCP_TOKEN!;
  const config = takeDesktopMcpConfig(environment)!; config.exposure="direct";
  expect(Object.keys(environment)).toEqual([]); expect(JSON.stringify(config.args)).not.toContain(token);
  const manager = new McpManager({servers:[config]}), tools = new ToolRegistry();
  const store = new SqliteRuntimeStore(join(root,"agent.sqlite3")); let calls = 0;
  const runtime = new TypeScriptAgentRuntime({permissionPolicy:new PermissionPolicyService(), store, tools, systemPrompt:"test", provider:{summarize:async()=>{throw new Error("unexpected summary");},turn:async request=>{
    if (++calls===1) return messageFixture({stopReason:"toolUse",content:[{type:"tool_call",id:"create",name:"mcp__lxe_desktop__automation_update",arguments:{mode:"create",definition:{name:"check",prompt:"report",timezone:"Asia/Shanghai",target:{mode:"reuse",session_id:"current"},schedule:{kind:"interval",minutes:60}}}}]});
    expect(JSON.stringify(request.messages)).not.toContain('"is_error":true');
    return messageFixture({content:[{type:"text",text:"scheduled"}]});
  }},emitter:{emit:async()=>{},typing:async()=>{}}});
  const job: AgentJob = {job_id:"t1",session_id:"s1",session_key:"s1",response_route_id:"r",user_id:"u",conversation_id:"s1",is_group:false,message_id:"t1",user_input:"schedule a check",job_kind:"turn",sender_nick:"test",source:{platform:"desktop"},raw_data:{},user_content_blocks:[],diagnostics:[],workspace};
  const handle={signal:new AbortController().signal,cancelled:false,drainSteering:()=>[],registerProcess:()=>()=>{}};
  try {
    await manager.start(tools); expect(manager.status(config.name).connected).toBe(true);
    await runtime.start(); await store.ensureSession({session_id:"s1",source:{platform:"desktop"},workspace});
    expect((await runtime.runTurn(job,handle)).status).toBe("completed"); expect(calls).toBe(2);
    expect(app.service.list()).toHaveLength(1); expect(app.service.list()[0]!.target).toEqual({mode:"reuse",session_id:"s1"});
    const connection = await new OfficialMcpConnector().connect(config);
    try {
      expect(connection.protocolVersion).toBe("2026-07-28");
      expect((await connection.callTool("automation_list",{})).isError).toBe(true);
      expect((await connection.callTool("automation_list",{},undefined,{"lxe.desktop/caller":{session_id:"s1",turn_id:"t1",tool_call_id:"foreign",platform:"feishu"}})).isError).toBe(true);
      active=false;
      expect((await connection.callTool("automation_list",{},undefined,{"lxe.desktop/caller":{session_id:"s1",turn_id:"t1",tool_call_id:"stale",platform:"desktop"}})).isError).toBe(true);
    } finally { await connection.close(); }
    await expect(requestDesktopPipe(pipe,"wrong-token","tools/list",{})).rejects.toThrow("authentication failed");
    await manager.setEnabled(config.name,false); expect(manager.status(config.name).connected).toBe(false);
    expect(app.service.list()).toHaveLength(1);
  } finally { await runtime.stop(); await manager.stop(); await app.close(); db.close(); rmSync(root,{recursive:true,force:true}); }
  if (process.platform!=="win32") expect(existsSync(pipe)).toBe(false);
}, 20_000);

test("pipe cancellation reaches the host, bounded framing rejects overflow, and close fails pending requests", async () => {
  let aborted=false, entered=false;
  const pipe=await startDesktopPipe({token:"secret",call:async(_method,_params,signal)=>{
    entered=true; await new Promise<void>(resolve=>signal.addEventListener("abort",()=>{aborted=true;resolve();},{once:true})); return {};
  }});
  const controller=new AbortController();
  const result=requestDesktopPipe(pipe.path,"secret","hang",{},controller.signal).catch(error=>error);
  await eventually(()=>entered); controller.abort(new Error("user cancelled")); expect(String(await result)).toContain("user cancelled");
  await eventually(()=>aborted); entered=false;
  const closed=requestDesktopPipe(pipe.path,"secret","hang",{}).catch(error=>error); await eventually(()=>entered); await pipe.close();
  expect(String(await closed)).toContain("closed");
  expect(()=>encodePipeFrame("x".repeat(1_048_576))).toThrow("1 MiB");
});
