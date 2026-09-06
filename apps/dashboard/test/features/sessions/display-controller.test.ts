import { expect, test } from "bun:test";
import { ConversationDisplayController, sendConversationMessage } from "../../../src/features/sessions/display-controller";
import type { SessionDetailPayload, SessionMessage, DesktopConversationTurnPayload } from "../../../src/api/payloads";
import type { DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";

const image: DesktopInputAttachmentPayload = {attachment_id:"image",name:"image.png",media_type:"image/png",size_bytes:12};
const history = (messages: SessionMessage[], sessionId = "s"): SessionDetailPayload => {
  const ids = [...new Set(messages.map(message => message.display_group_id))];
  return {session:{session_id:sessionId},messages,messages_page:{group_cursors:ids,total:ids.length,raw_message_total:messages.length,limit:10,fetched_at:1,
    oldest_cursor:ids[0]??null,newest_cursor:ids.at(-1)??null,previous_cursor:null,has_previous:false,next_cursor:null,has_next:false}} as SessionDetailPayload;
};
const saved = (id:string, attachments:DesktopInputAttachmentPayload[]=[], state="running"):SessionMessage => ({display_group_id:"g",display_id:"user",client_message_id:id,message_id:"m",role:"user",content:"hello",attachments,turn:{turn_id:"turn",status:state,elapsed_ms:10}} as SessionMessage);
const live = (id:string,state="running",seq=1,body="new body"):DesktopConversationTurnPayload => ({turn_id:"turn",message_id:"m",client_message_id:id,text:"hello",attachments:[image],created_at:10,started_at:10,settled_at:state==="running"?0:20,user_persisted_at:10,state,
  stream:{seq,process_parts:[{type:"text",part_id:"answer:0",sequence:1,text:body,status:state==="running"?"running":"completed",presentation:"final"}],display_metrics:{phase:"waiting_model"}} as unknown as DesktopConversationTurnPayload["stream"]} as DesktopConversationTurnPayload);
const activity=(turn:DesktopConversationTurnPayload)=>({session_id:"s",queued:[],active:turn.state==="running"?turn:null,latest:turn.state==="running"?null:turn});
const result={session_id:"s",message_id:"m",turn_id:"turn",state:"running" as const,created:false};
const users=(c:ConversationDisplayController)=>c.getSnapshot().rows.filter(row=>row.message?.role==="user");
const setup=()=>{const c=new ConversationDisplayController();c.select("s");c.receiveHistory(history([]),"latest");return c;};

test("empty history then first text, image or attachment-only send keeps bubble visible at every handoff",()=>{
  for(const attachments of [[],[image]]) for(const body of ["hello",""]) {
    const c=setup();const ticket=c.beginSend(body,attachments);
    expect(users(c).map(row=>row.id)).toEqual([`user:${ticket.pendingId}`]);
    c.receiveHistory(history([saved(ticket.pendingId)]),"latest");
    expect(c.getSnapshot().connection).toBe("attached");expect(users(c)).toHaveLength(1);
    expect(users(c)[0]!.message!.attachments).toEqual(attachments);
    expect(c.getSnapshot().pending.length).toBe(attachments.length?1:0);
    c.acceptSend(ticket,result);c.receiveActivity(activity(live(ticket.pendingId)));
    c.receiveHistory(history([saved(ticket.pendingId,attachments)]),"latest");
    expect(users(c)).toHaveLength(1);expect(c.getSnapshot().pending).toHaveLength(0);
  }
});

test("all acknowledgement/activity/history orderings and duplicates keep one bubble and terminal state",()=>{
  const orders=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  for(const order of orders){const c=setup(),ticket=c.beginSend("hello",[image]);
    const steps=[()=>c.acceptSend(ticket,result),()=>c.receiveActivity(activity(live(ticket.pendingId,"error"))),()=>c.receiveHistory(history([saved(ticket.pendingId,[image],"error")]),"latest")];
    for(const index of [...order,...order]) {steps[index]!();expect(users(c)).toHaveLength(1);}
    expect(c.getSnapshot().rows.find(row=>row.kind==="status")?.status).toBe("error");
  }
});

test("same body is not an identity and local send failures retain actual error",async()=>{
  const c=setup();c.beginSend("same",[]);c.beginSend("same",[]);expect(users(c)).toHaveLength(2);
  await expect(sendConversationMessage(c,"failed",[],async()=>{throw new Error("actual network error");})).rejects.toThrow("actual network error");
  expect(users(c).at(-1)?.error).toBe("actual network error");
});

test("history started before new stream and terminal updates cannot revert either",()=>{
  const c=setup();const ticket=c.beginSend("hello",[]);c.acceptSend(ticket,result);c.receiveActivity(activity(live(ticket.pendingId)));
  const request=c.beginHistory();c.receiveActivity(activity(live(ticket.pendingId,"error",2,"newest body")));
  const assistant={...saved(ticket.pendingId),role:"assistant",id:"answer",content:[{type:"text",text:"stale body"}]} as SessionMessage;
  c.completeHistory(request,history([saved(ticket.pendingId),assistant]),"latest");
  expect(c.getSnapshot().rows.find(row=>row.id==="answer:0")?.message?.content).toEqual([{type:"text",text:"newest body"}]);
  expect(c.getSnapshot().rows.find(row=>row.kind==="status")?.status).toBe("error");
  c.receiveActivity(activity(live(ticket.pendingId,"running",1,"older body")));
  expect(c.getSnapshot().rows.find(row=>row.kind==="status")?.status).toBe("error");
});

const page=(start:number,end:number)=>history(Array.from({length:end-start},(_,offset)=>({display_group_id:`g${start+offset}`,display_id:`g${start+offset}:0`,role:"user",content:`message ${start+offset}`,created_at:start+offset} as SessionMessage)));
test("continuous anchored view keeps live rows; only disconnected history separates the tail; send rejoins",()=>{
  const c=setup();c.receiveHistory(page(0,10),"latest");c.setFollowing(false);
  c.receiveActivity(activity(live("new")));expect(users(c)).toHaveLength(11);
  c.receiveHistory(page(20,30),"latest");expect(c.getSnapshot().connection).toBe("detached");
  expect(c.getSnapshot().detail?.messages[0]?.display_group_id).toBe("g0");expect(users(c)).toHaveLength(10);
  c.beginSend("new send",[]);expect(c.getSnapshot()).toMatchObject({connection:"attached",following:true});
  expect(c.getSnapshot().detail?.messages[0]?.display_group_id).toBe("g20");expect(users(c).at(-1)?.message?.content).toBe("new send");
  const following=setup();following.receiveHistory(page(0,10),"latest");following.receiveHistory(page(20,30),"latest");
  expect(following.getSnapshot().detail?.messages[0]?.display_group_id).toBe("g20");
});

test("draft adoption keeps display identity, and late send response cannot navigate another selection",()=>{
  const c=new ConversationDisplayController();const key=c.getSnapshot().viewKey,ticket=c.beginSend("hello",[image]);
  expect(c.acceptSend(ticket,result)).toBe(true);expect(c.getSnapshot().viewKey).toBe(key);expect(users(c)[0]?.id).toBe(`user:${ticket.pendingId}`);
  const late=c.beginSend("next",[]);c.select("other");expect(c.acceptSend(late,result)).toBe(false);expect(c.getSnapshot().sessionId).toBe("other");expect(users(c)).toHaveLength(0);
  c.select("s");expect(users(c)).toHaveLength(2);
});

test("obsolete history after jump or session switch is ignored and failure keeps window",()=>{
  const c=setup();c.receiveHistory(page(0,10),"latest");const request=c.beginHistory();c.jumpToLatest();
  expect(c.completeHistory(request,page(10,20),"older")).toBe(false);
  const switched=c.beginHistory();c.select("other");expect(c.completeHistory(switched,page(0,10),"latest")).toBe(false);
  c.receiveHistory(history([saved("x")],"other"),"latest");c.failHistory(new Error("history failed"));expect(users(c)).toHaveLength(1);expect(c.getSnapshot().error).toBe("history failed");
});

test("1000 groups can be reloaded bidirectionally within combined tail/window budget",()=>{
  const c=setup();c.receiveHistory(page(990,1000),"latest");c.setFollowing(false);
  for(let i=980;i>=0;i-=10){c.setVisibleGroups([`g${i+10}`]);c.receiveHistory(page(i,i+10),"older");
    const ids=new Set([...c.getSnapshot().detail!.messages,...c.getSnapshot().latest!.messages].map(m=>m.display_group_id));expect(ids.size).toBeLessThanOrEqual(60);}
  expect(c.getSnapshot().detail!.messages[0]!.display_group_id).toBe("g0");
  while(c.getSnapshot().detail!.messages.at(-1)!.display_group_id!=="g999"){
    const next=Number(c.getSnapshot().detail!.messages.at(-1)!.display_group_id.slice(1))+1;
    c.setVisibleGroups([`g${next-1}`]);c.receiveHistory(page(next,Math.min(1000,next+10)),"newer");
  }
  expect(c.getSnapshot().connection).toBe("attached");
});

test("a delayed running activity cannot revive a fully persisted completed turn",()=>{
  const c=setup(),ticket=c.beginSend("hello",[image]);
  c.acceptSend(ticket,result);c.receiveActivity(activity(live(ticket.pendingId,"completed")));
  c.receiveHistory(history([saved(ticket.pendingId,[image],"completed"),{...saved(ticket.pendingId,[],"completed"),role:"assistant",id:"answer",content:[{type:"text",text:"new body"}]}]),"latest");
  c.receiveActivity(activity(live(ticket.pendingId,"running",1,"stale")));
  expect(c.getSnapshot().activity?.active).toBeNull();
  expect(c.getSnapshot().rows.find(row=>row.kind==="status")?.status).toBe("completed");
  expect(c.getSnapshot().rows.find(row=>row.id==="answer:0")?.message?.content).toEqual([{type:"text",text:"new body"}]);
});


test("starting another blank draft isolates the previous send and its late acknowledgement",()=>{
  const c=new ConversationDisplayController(),ticket=c.beginSend("old draft",[]);
  c.select("",true);expect(users(c)).toHaveLength(0);
  expect(c.acceptSend(ticket,result)).toBe(false);expect(c.getSnapshot().sessionId).toBe("");
});

test("a nonoverlapping latest replacement invalidates pagination from its former window",()=>{
  const c=setup();c.receiveHistory(page(0,10),"latest");const obsolete=c.beginHistory();
  c.receiveHistory(page(50,60),"latest");
  expect(c.completeHistory(obsolete,page(10,20),"newer")).toBe(false);
  expect(c.getSnapshot().detail!.messages[0]!.display_group_id).toBe("g50");
});
