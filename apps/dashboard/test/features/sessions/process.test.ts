import { expect, test } from "bun:test";
import { conversationRows, type ConversationRow } from "../../../src/features/sessions/presentation";
import { processHeaders, reconcileProcesses, visibleProcessRows } from "../../../src/features/sessions/process";
import type { SessionMessage } from "../../../src/api/payloads";

const history = (status = "completed") => [
  {role:"user",content:"question",display_id:"user",client_message_id:"client"},
  {role:"assistant",id:"first",content:[{type:"thinking",thinking:"reason"},{type:"text",text:"checking"},{type:"tool_call",id:"call",name:"read",arguments:{path:"a"}}]},
  {role:"tool",content:[{type:"tool_result",tool_call_id:"call",content:"result"}]},
  {role:"assistant",id:"last",content:[{type:"thinking",thinking:"conclusion"},{type:"text",text:"answer"}],attachments:[{id:"attachment"}]},
].map(message=>({...message,display_group_id:"group",created_at:1,turn:{turn_id:"turn",status,elapsed_ms:14000}})) as SessionMessage[];

test("history hides all process, keeps final text and user IDs; reopening preserves order",()=>{
  const rows=conversationRows(history(),[],[]);
  const headers=processHeaders(rows);
  const state=reconcileProcesses(new Map(),headers);
  expect(headers).toHaveLength(1);
  expect(visibleProcessRows(rows,headers,state).map(row=>row.id)).toEqual(["user:client","process:turn","last:1","answer-meta:turn:turn"]);
  state.set("process:turn",{status:"completed",expanded:true});
  expect(visibleProcessRows(rows,headers,state).map(row=>row.id)).toEqual(["user:client","process:turn","first:0","first:1","tool:turn:call","last:0","last:1","answer-meta:turn:turn"]);
  expect(rows.find(row=>row.id==="last:1")?.message?.attachments).toHaveLength(1);
});
test("completion collapses once, repeated persisted terminal never overwrites manual reopening",()=>{
  const header={id:"process:turn",kind:"process",status:"running"} as ConversationRow;
  let state=reconcileProcesses(new Map(),[header]);
  expect(state.get(header.id)?.expanded).toBe(true);
  state.set(header.id,{status:"running",expanded:false});
  expect(reconcileProcesses(state,[header])).toBe(state);
  state=reconcileProcesses(state,[{...header,status:"completed"}]);
  expect(state.get(header.id)?.expanded).toBe(false);
  state.set(header.id,{status:"completed",expanded:true});
  expect(reconcileProcesses(state,[{...header,status:"completed"}])).toBe(state);
  expect(state.get(header.id)?.expanded).toBe(true);
});
test("failed and cancelled history remains expanded and terminal status survives in header",()=>{
  for(const status of ["error","cancelled"]){
    const rows=conversationRows(history(status),[],[]), headers=processHeaders(rows);
    const state=reconcileProcesses(new Map(),headers);
    expect(state.get("process:turn")?.expanded).toBe(true);
    expect(headers[0]?.status).toBe(status);
    expect(visibleProcessRows(rows,headers,state).some(row=>row.id==="last:1")).toBe(true);
  }
});
test("a final-only reply has no empty process toggle",()=>{
  const rows=conversationRows([{display_group_id:"g",id:"answer",role:"assistant",content:"only answer"}],[],[]);
  expect(processHeaders(rows)).toHaveLength(0);
});

test("a reply without process keeps its status above the answer through completion and history handoff",()=>{
  const turn = {turn_id:"turn",message_id:"user",client_message_id:"client",text:"question",created_at:1000,started_at:1000,settled_at:0,state:"running",stream:{display_metrics:{phase:"generating_answer"},process_parts:[
    {type:"text",part_id:"answer:0",sequence:0,text:"only answer",status:"streaming",presentation:"final"},
  ]}} as unknown as import("../../../src/api/payloads").DesktopConversationTurnPayload;
  const saved = [
    {id:"user",role:"user",client_message_id:"client",content:"question"},
    {id:"answer",role:"assistant",content:[{type:"text",text:"only answer"}]},
  ].map(message=>({...message,display_group_id:"group",created_at:1,turn:{turn_id:"turn",status:"completed",elapsed_ms:24000}})) as SessionMessage[];
  const completed = {...turn,state:"completed" as const,settled_at:25000};
  for(const [messages,turns] of [[[],[turn]],[[],[completed]],[saved,[completed]],[saved,[]]] as [SessionMessage[],typeof turn[]][]){
    const rows=conversationRows(messages,turns,[]);
    const headers=processHeaders(rows);
    expect(headers).toHaveLength(0);
    expect(visibleProcessRows(rows,headers,new Map()).map(row=>row.id)).toEqual([
      "user:client","status:turn","answer:0","answer-meta:turn:turn",
    ]);
    expect(rows.find(row=>row.kind==="status")?.status).toBe(turns[0]?.state ?? "completed");
    if(turns[0]?.state!=="running") expect(rows.find(row=>row.kind==="status")?.elapsedMs).toBe(24000);
  }
});

test("live classification wins over partial history and preserves failed attempts through handoff",()=>{
  const turn = {turn_id:"turn",message_id:"server",client_message_id:"client",text:"question",created_at:1,started_at:1,settled_at:0,state:"running",stream:{display_metrics:{phase:"generating_answer"},process_parts:[
    {type:"text",part_id:"retry:0",sequence:0,text:"failed partial",status:"error",presentation:"process"},
    {type:"text",part_id:"first:0",sequence:1,text:"checking",status:"completed",presentation:"process"},
    {type:"tool",part_id:"tool:call",sequence:2,tool_step:{id:"call",name:"read",status:"completed"}},
    {type:"thinking",part_id:"last:0",sequence:3,text:"reason",status:"completed",redacted_count:0},
    {type:"text",part_id:"last:1",sequence:4,text:"answer",status:"completed",presentation:"final"},
  ]}} as unknown as import("../../../src/api/payloads").DesktopConversationTurnPayload;
  const partial=[{display_group_id:"g",id:"first",role:"assistant",content:[{type:"text",text:"checking"}],turn:{turn_id:"turn",status:null,elapsed_ms:null}}] as SessionMessage[];
  const rows=conversationRows(partial,[turn],[]);
  expect(rows.find(row=>row.id==="first:0")?.presentation).toBe("process");
  expect(rows.find(row=>row.id==="last:1")?.presentation).toBe("final");
  const headers=processHeaders(rows), states=reconcileProcesses(new Map(),headers);
  expect(states.get("process:turn")?.expanded).toBe(true);
  const completed=conversationRows(partial,[{...turn,state:"completed",settled_at:100}],[]);
  const completedHeaders=processHeaders(completed);
  const closed=reconcileProcesses(states,completedHeaders);
  expect(visibleProcessRows(completed,completedHeaders,closed).map(row=>row.id)).toEqual(["user:client","process:turn","last:1","answer-meta:turn:turn"]);
});
