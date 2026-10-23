import { expect, test } from "bun:test";
import { parseDashboardRpcCall, parseAgentDashboardRpcCall } from "../src/dashboard-rpc";

const definition={name:"report",prompt:"work",timezone:"Asia/Shanghai",schedule:{kind:"interval",minutes:60},target:{mode:"reuse",session_id:"s"}} as const;
test("desktop automation contracts are strict and never accepted as Agent-owned RPCs",()=>{
  const call={operation:"automations.save",input:{definition}} as const;
  expect(parseDashboardRpcCall(call)).toEqual(call);
  expect(()=>parseAgentDashboardRpcCall(call)).toThrow();
  expect(()=>parseDashboardRpcCall({...call,input:{definition,id:"a"}})).toThrow("id and version");
  expect(()=>parseDashboardRpcCall({...call,input:{definition:{...definition,target:{mode:"reuse",session_id:"s",workspace_id:"w"}}}})).toThrow("Unsupported");
  expect(()=>parseDashboardRpcCall({...call,input:{definition:{...definition,timezone:"invalid/zone"}}})).toThrow();
  expect(()=>parseDashboardRpcCall({...call,input:{definition:{...definition,schedule:{kind:"interval",minutes:0}}}})).toThrow();
  expect(()=>parseDashboardRpcCall({operation:"automations.editing",input:{session_id:"s",editing:1}})).toThrow();
});
test("turn navigation rejects ambiguous pagination and lookup requires a concrete turn",()=>{
  expect(parseDashboardRpcCall({operation:"sessions.detail",input:{session_id:"s",message_turn_id:"t"}})).toMatchObject({input:{message_turn_id:"t"}});
  expect(()=>parseDashboardRpcCall({operation:"sessions.detail",input:{session_id:"s",message_turn_id:"t",message_before:"c"}})).toThrow("mutually exclusive");
  expect(()=>parseDashboardRpcCall({operation:"sessions.turn.lookup",input:{session_id:"s"}})).toThrow();
});
