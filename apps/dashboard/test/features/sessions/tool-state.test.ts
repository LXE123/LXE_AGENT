import { expect, test } from "bun:test";
import type { DesktopConversationTurnPayload, SessionDetailPayload, SessionMessage } from "../../../src/api/payloads";
import { conversationRows } from "../../../src/features/sessions/presentation";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";
import { mergeToolStream } from "../../../src/features/sessions/tool-state";
import { formatCommandPayload } from "../../../../../packages/agent/runtime/src/tooling/process-output";

type Stream = NonNullable<DesktopConversationTurnPayload["stream"]>;
const step = (id: string, status = "running") => ({ id, name: "exec", detail: "fixture command", status, duration_ms: 10,
  ...(status === "success" ? { result_block: { content: "done", language: "text" } } : {}),
  ...(status === "error" ? { error_block: { content: "actual failure", language: "text" } } : {}) });
const stream = (seq = 1, status = "running", id = "call", text = "current text"): Stream => ({
  seq, tool_steps: [step(id, status)], process_parts: [
    {type:"text",part_id:"answer:0",sequence:1,text,status:"streaming",presentation:"process"},
    {type:"tool",part_id:`tool:${id}`,sequence:2,tool_step:step(id,status)},
  ], display_metrics:{phase:"running_tool"},
} as Stream);
const turn = (seq = 1, status = "running", state = "running"): DesktopConversationTurnPayload => ({
  turn_id:"t",message_id:"u",text:"question",created_at:1000,started_at:1000,settled_at:state==="running"?0:2000,
  state,stream:stream(seq,status),
} as DesktopConversationTurnPayload);
const call = (id = "call", state = "running"): SessionMessage => ({
  id:"answer",display_id:"answer",display_group_id:"g",role:"assistant",created_at:1,
  content:[{type:"tool_call",id,name:"exec",arguments:{cmd:"fixture command"}}],turn:{turn_id:"t",status:state},
} as SessionMessage);
const result = (status = "success", id = "call"): SessionMessage => ({
  ...call(id),id:`result:${id}`,display_id:`result:${id}`,role:"tool",
  content:[{type:"tool_result",tool_call_id:id,content:"done",is_error:status==="error",...(status==="running"?{display_status:"running"}:{})}],
});
const user: SessionMessage = {...call(),id:"u",display_id:"u",message_id:"u",role:"user",content:"question"};
const page = (messages: SessionMessage[], state = "running"): SessionDetailPayload => ({
  session:{session_id:"s"},messages:messages.map(m=>({...m,turn:{turn_id:"t",status:state}})),
  messages_page:{group_cursors:["g"],total:1,raw_message_total:messages.length,limit:10,oldest_cursor:"g",newest_cursor:"g",
    previous_cursor:null,next_cursor:null,has_previous:false,has_next:false,fetched_at:1},
} as SessionDetailPayload);
const activity = (value: DesktopConversationTurnPayload) => ({session_id:"s",active:value.state==="running"?value:null,latest:value.state==="running"?null:value,queued:[]});
const tool = (c: ConversationDisplayController) => c.getSnapshot().rows.find(row=>row.id==="tool:t:call")!;
const status = (c: ConversationDisplayController) => tool(c).operation?.status ?? tool(c).liveTool?.status;
const controller = () => {const c=new ConversationDisplayController();c.select("s");return c;};

test("call-only history is pending only in an active turn, otherwise unconfirmed",()=>{
  for(const state of ["completed","error","cancelled",undefined]){
    const message={...call(),turn:state?{turn_id:"t",status:state}:undefined} as SessionMessage;
    expect(conversationRows([message],[],[]).find(row=>row.kind==="tool")?.operation?.status).toBe("unconfirmed");
  }
  const active={...turn(),stream:undefined};
  expect(conversationRows([call("call","completed")],[active],[]).find(row=>row.kind==="tool")?.operation?.status).toBe("pending");
});

test("history refresh never replaces started tools; terminal evidence survives stale history and activity",()=>{
  for(const end of ["success","error"]){
    const c=controller();c.receiveActivity(activity(turn()));
    for(let i=0;i<4;i++){c.receiveHistory(page([user,call()]),"latest");expect(status(c)).toBe("running");}
    const request=c.beginHistory();c.receiveActivity(activity(turn(2,end)));
    c.completeHistory(request,page([user,call()]),"latest");expect(status(c)).toBe(end);
    for(const seq of [1,2,3]){c.receiveActivity(activity(turn(seq)));expect(status(c)).toBe(end);}
    c.receiveHistory(page([user,call(),result(end)],"completed"),"latest");expect(status(c)).toBe(end);
    c.receiveHistory(page([user,call()]),"latest");expect(status(c)).toBe(end);
    expect(tool(c).id).toBe("tool:t:call");
  }
});

test("yielded command stays running after turn settles, same-seq background end changes tools only",()=>{
  const c=controller();c.receiveActivity(activity(turn(4,"running","completed")));
  c.receiveHistory(page([user,call(),result("running")],"completed"),"latest");
  expect(status(c)).toBe("running");
  const ended=turn(4,"success","completed");
  ended.stream=stream(4,"success","call","stale replacement text");
  c.receiveActivity(activity(ended));expect(status(c)).toBe("success");
  expect(c.getSnapshot().rows.find(row=>row.id==="answer:0")?.message?.content).toEqual([{type:"text",text:"current text"}]);
  expect(c.getSnapshot().activity?.latest?.stream?.tool_steps[0]?.status).toBe("success");
  c.receiveActivity(activity(turn(4,"running","completed")));expect(status(c)).toBe("success");
});

test("stream merge rejects low seq, accepts equal-seq ends, preserves terminal states in higher seq",()=>{
  const previous=stream(5);
  expect(mergeToolStream(previous,stream(4,"success"))).toBe(previous);
  expect(mergeToolStream(previous,stream(5))).toBe(previous);
  const finished=mergeToolStream(previous,stream(5,"error"))!;
  expect(finished.process_parts[0]).toBe(previous.process_parts[0]);
  const newer=mergeToolStream(finished,stream(6))!;
  expect(newer.tool_steps[0]?.status).toBe("error");
  expect(newer.process_parts[1]?.type==="tool"&&newer.process_parts[1].tool_step.status).toBe("error");
});

test("multiple calls and retry IDs remain independent and history details confirm release",()=>{
  const c=controller();const initial=turn();
  initial.stream={...stream(),tool_steps:[step("call"),step("retry")],process_parts:[
    {type:"tool",part_id:"tool:call",sequence:1,tool_step:step("call")},
    {type:"tool",part_id:"tool:retry",sequence:2,tool_step:step("retry")},
  ]} as Stream;
  c.receiveActivity(activity(initial));
  const next=structuredClone(initial);next.stream!.seq=2;
  (next.stream!.process_parts[0] as Extract<Stream["process_parts"][number],{type:"tool"}>).tool_step=step("call","error") as Stream["tool_steps"][number];
  c.receiveActivity(activity(next));expect(status(c)).toBe("error");
  expect(c.getSnapshot().rows.find(row=>row.id==="tool:t:retry")?.liveTool?.status).toBe("running");
  c.select("other");c.select("s");c.receiveHistory(page([user,call()],"cancelled"),"latest");
  expect(status(c)).toBe("unconfirmed");
});

test("a completed tool is released after matching result confirmation; running background tool is not",()=>{
  for(const end of ["success","running"]){
    const c=controller();const active={...turn(1,end,"completed"),stream:{...stream(1,end),process_parts:stream(1,end).process_parts.slice(1)}};
    c.receiveActivity(activity(active));
    c.receiveHistory(page([user,call(),result(end)],"completed"),"latest");
    // Test the owning cache directly: rendered rows alone cannot detect a retained live payload.
    expect((c as unknown as {turns:Map<string,unknown>}).turns.size).toBe(end==="success"?0:1);
    if(end==="success")expect(tool(c).liveTool).toBeUndefined();
  }
});

test("persisted yielded exec observations are not process completion; stdout is not control metadata",()=>{
  for(const name of ["exec","wait"]){
    const command={...call(),content:[{type:"tool_call",id:"call",name,arguments:{}}]};
    const observation={...result(),content:[{type:"tool_result",tool_call_id:"call",content:[{type:"text",
      text:formatCommandPayload({exec_id:"exec_fixture",status:"running",output:"no new output"})}]}]};
    const c=controller();c.receiveHistory(page([command,observation],"completed"),"latest");
    expect(status(c)).toBe("unconfirmed");
    c.receiveActivity(activity(turn(1,"running","completed")));expect(status(c)).toBe("running");
    c.receiveActivity(activity(turn(1,"success","completed")));expect(status(c)).toBe("success");
    observation.content=[{type:"tool_result",tool_call_id:"call",content:[{type:"text",
      text:formatCommandPayload({exec_id:"exec_fixture",status:"completed",output:"exec_id: fake\nstatus: running"})}]}];
    expect(conversationRows([command,observation],[],[]).find(row=>row.kind==="tool")?.operation?.status).toBe("success");
  }
});

test("terminal evidence is bounded by the displayed window and never crosses sessions",()=>{
  const c=controller();c.receiveHistory(page([call(),result()],"completed"),"latest");
  expect((c as unknown as {toolEvidence:Map<string,unknown>}).toolEvidence.size).toBe(1);
  const next=page([{...user,display_group_id:"other",turn:{turn_id:"other",status:"completed"}}],"completed");
  next.messages_page.group_cursors=["other"];next.messages_page.newest_cursor="other";
  c.receiveHistory(next,"latest");
  expect((c as unknown as {toolEvidence:Map<string,unknown>}).toolEvidence.size).toBe(0);
  c.select("different");expect(c.getSnapshot().rows).toEqual([]);
});

test("reused provider call IDs in different turns have independent result pairing and stable row IDs",()=>{
  const secondCall={...call(),id:"second-answer",display_id:"second-answer",display_group_id:"second-group",turn:{turn_id:"second",status:"completed"}} as SessionMessage;
  const secondResult={...result("error"),id:"second-result",display_id:"second-result",display_group_id:"second-group",turn:secondCall.turn};
  const first=conversationRows([call(),result()],[],[]).find(row=>row.kind==="tool")!;
  const combined=conversationRows([call(),result(),secondCall,secondResult],[],[]).filter(row=>row.kind==="tool");
  expect(combined.map(row=>[row.id,row.operation?.status])).toEqual([["tool:t:call","success"],["tool:second:call","error"]]);
  expect(combined[0]?.id).toBe(first.id);
});
