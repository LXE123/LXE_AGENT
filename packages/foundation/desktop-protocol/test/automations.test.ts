import { expect, test } from "bun:test";
import { parseDashboardRpcCall, parseAgentDashboardRpcCall } from "../src/dashboard-rpc";
import { parseAutomationDefinition } from "../src/automations";

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

test("task names can be omitted on save while stored definitions still require a name", () => {
  const task = { prompt: "生成日报", timezone: "Asia/Shanghai", schedule: { kind: "interval", minutes: 60 }, target: { mode: "new", workspace_id: "w" } };
  expect(parseDashboardRpcCall({ operation: "automations.save", input: { definition: task } })).toMatchObject({ input: { definition: { name: "" } } });
  expect(() => parseAutomationDefinition(task)).toThrow("name");
});

test("thinking levels belong to new conversations and reject malformed inputs", () => {
  const task = { ...definition, target: { mode: "new" as const, workspace_id: "w", effort: "high" } };
  expect(parseAutomationDefinition(task).target).toEqual(task.target);
  expect(() => parseAutomationDefinition({ ...task, target: { ...task.target, effort: "" } })).toThrow("effort");
  expect(() => parseAutomationDefinition({ ...definition, target: { ...definition.target, effort: "high" } })).toThrow("Unsupported");
});

test("title RPC accepts bounded text and a single model scope", () => {
  expect(parseAgentDashboardRpcCall({ operation: "titles.generate", input: { text: "日报" } })).toMatchObject({ input: { text: "日报" } });
  for (const input of [{ text: "" }, { text: "a".repeat(32769) }, { text: "title", session_id: "s", model: { provider: "p", model: "m", credential_source: "local" } }, { text: "title", tools: [] }]) {
    expect(() => parseAgentDashboardRpcCall({ operation: "titles.generate", input })).toThrow();
  }
});
