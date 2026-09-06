// Browser acceptance uses the production Query hook, controller, send helper and full view.
import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { callDashboard, setDashboardTransportForTests } from "../../../src/api/client";
import { useSessionConversationQuery, useConversationActivityQuery } from "../../../src/api/queries";
import { dashboardQueryKeys } from "../../../src/api/query-keys";
import { ConversationDisplayController, sendConversationMessage } from "../../../src/features/sessions/display-controller";
import { acknowledgeConversationSend } from "../../../src/features/sessions/presentation";
import { SessionDetailView } from "../../../src/features/sessions/view";
import type { SessionDetailPayload, SessionMessage, SessionPayload, DesktopConversationTurnPayload } from "../../../src/api/payloads";
import type { DesktopConversationActivityPayload, DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";
import "../../../src/styles.css";
const delay = (ms = 60) => new Promise<void>(resolve => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const client = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const records = new Map<string, SessionMessage[]>();
const activities = new Map<string, DesktopConversationActivityPayload>();
const attachment: DesktopInputAttachmentPayload = {attachment_id:"fixture-image",name:"fixture.png",size_bytes:100,media_type:"image/png"};
let serial=0, sendState: "completed"|"error"|"cancelled"|"transport-error"="completed", failNextPage=false, pageDelay=15;
const session=(id:string):SessionPayload=>({session_id:id,title:"展示控制器 fixture",source:{},source_summary:{platform:"desktop",chat_type:"dm"},workspace:{directory:"/fixture",worktree:"/fixture"},model:"fixture",reasoning_effort:"",model_config:{},pinned_at:0,created_at:1,last_active_at:1,message_count:0,tool_call_count:0,input_tokens:0,output_tokens:0,api_call_count:0});
function page(id:string,before?:string,after?:string):SessionDetailPayload{
  const messages=records.get(id)??[];
  const groups=[...new Set(messages.map(message=>message.display_group_id))];
  const boundary=before?groups.indexOf(before):after?groups.indexOf(after)+1:groups.length;
  const start=after?boundary:Math.max(0,boundary-10),end=after?Math.min(groups.length,boundary+10):boundary;
  const ids=groups.slice(start,end);
  return {session:session(id),messages:messages.filter(message=>ids.includes(message.display_group_id)),messages_page:{fetched_at:Date.now(),total:groups.length,raw_message_total:messages.length,limit:10,group_cursors:ids,
    oldest_cursor:ids[0]??null,newest_cursor:ids.at(-1)??null,previous_cursor:start?ids[0]??null:null,has_previous:start>0,next_cursor:end<groups.length?ids.at(-1)??null:null,has_next:end<groups.length}};
}
const push=(id:string,turn:DesktopConversationTurnPayload)=>{
  const value={session_id:id,active:turn.state==="running"?turn:null,latest:turn.state==="running"?null:turn,queued:[]};
  activities.set(id,value);client.setQueryData(dashboardQueryKeys.sessions.activity(id),value);
};
setDashboardTransportForTests({call:async(call)=>{
  if(call.operation==="sessions.attachment.preview")return {data_url:"data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#d4c4ac"/><text x="20" y="55">Fixture image</text></svg>')} as never;
  if(call.operation==="sessions.detail"){
    const input=call.input as {session_id:string;message_before?:string;message_after?:string};
    const captured=page(input.session_id,input.message_before,input.message_after);
    await delay(pageDelay);
    if(failNextPage){failNextPage=false;throw new Error("Fixture history unavailable");}
    return captured as never;
  }
  if(call.operation==="sessions.activity")return (activities.get((call.input as {session_id:string}).session_id)??{session_id:(call.input as {session_id:string}).session_id,active:null,queued:[],latest:null}) as never;
  if(call.operation!=="sessions.send")throw new Error(`Unexpected fixture operation ${call.operation}`);
  const input=call.input as {session_id?:string;client_message_id:string;text:string;attachment_ids?:string[]};
  const id=input.session_id||`created-${++serial}`,turnId=`turn-${++serial}`,messageId=`message-${serial}`,outcome=sendState;
  await delay();
  if(outcome==="transport-error")throw new Error("Fixture actual send error");
  const turn:DesktopConversationTurnPayload={turn_id:turnId,message_id:messageId,client_message_id:input.client_message_id,text:input.text,attachments:input.attachment_ids?.length?[attachment]:[],created_at:Date.now(),started_at:Date.now(),user_persisted_at:Date.now(),settled_at:0,state:"running"};
  push(id,turn);await delay();
  const user:SessionMessage={display_group_id:turnId,display_id:messageId,role:"user",message_id:messageId,client_message_id:input.client_message_id,content:input.text,created_at:Date.now()/1000,turn:{turn_id:turnId,status:"running",elapsed_ms:0}};
  records.set(id,[...records.get(id)??[],user]);
  await client.invalidateQueries({queryKey:dashboardQueryKeys.sessions.detailSession(id)});await delay();
  const body=outcome==="completed"?"**最终回答**：图片已收到。":"Fixture actual model failure";
  const final={...turn,state:outcome,settled_at:Date.now(),stream:{seq:1,process_parts:[
    {type:"thinking",part_id:`${messageId}:0`,sequence:1,text:"检查输入\n\n准备回答",status:"completed",redacted_count:0},
    {type:"text",part_id:`${messageId}:1`,sequence:2,text:body,status:outcome==="completed"?"completed":"error",presentation:"final"}],display_metrics:{phase:"generating_answer"}}} as DesktopConversationTurnPayload;
  push(id,final);
  records.set(id,[...(records.get(id)??[]).filter(message=>message.message_id!==messageId),{...user,attachments:turn.attachments,turn:{...user.turn!,status:outcome}},
    {display_group_id:turnId,display_id:`${messageId}:assistant`,id:messageId,role:"assistant",content:[{type:"thinking",thinking:"检查输入\n\n准备回答"},{type:"text",text:body}],created_at:Date.now()/1000,turn:{turn_id:turnId,status:outcome,elapsed_ms:300}}]);
  await client.invalidateQueries({queryKey:dashboardQueryKeys.sessions.detailSession(id)});await delay();
  return {session_id:id,turn_id:turnId,message_id:messageId,state:"running",created:!input.session_id} as never;
}});
function anchor(){const root=document.querySelector<HTMLElement>(".conversation-transcript")!;const top=root.getBoundingClientRect().top;
  const row=[...root.querySelectorAll<HTMLElement>("[data-conversation-row]")].find(element=>element.getBoundingClientRect().bottom>top);
  return row?{id:row.dataset.conversationRow!,offset:row.getBoundingClientRect().top-top}:null;
}
function anchorError(saved:ReturnType<typeof anchor>){const root=document.querySelector<HTMLElement>(".conversation-transcript")!;
  const row=[...root.querySelectorAll<HTMLElement>("[data-conversation-row]")].find(element=>element.dataset.conversationRow===saved?.id);
  return row&&saved?Math.abs(row.getBoundingClientRect().top-root.getBoundingClientRect().top-saved.offset):Infinity;
}
const noop=async()=>{};
function Fixture(){
  const [controller]=useState(()=>new ConversationDisplayController());
  const [id,setId]=useState("empty");const [reports,setReports]=useState<string[]>([]);const [busy,setBusy]=useState(false);
  const query=useSessionConversationQuery(id,true,controller);useConversationActivityQuery(id);
  const current=useRef(query);current.current=query;
  const select=(value:string)=>{controller.select(value);setId(value);};
  const report=(value:string)=>setReports(values=>[...values,value]);
  const send=async(text:string,files:DesktopInputAttachmentPayload[]=[])=>{
    const {result,ticket,selected}=await sendConversationMessage(controller,text,files,input=>callDashboard({operation:"sessions.send",input}));
    client.setQueryData<DesktopConversationActivityPayload>(dashboardQueryKeys.sessions.activity(result.session_id),value=>acknowledgeConversationSend(value,result,ticket.message));
    if(selected){select(result.session_id);}
    await client.invalidateQueries({queryKey:dashboardQueryKeys.sessions.detailSession(result.session_id)});
  };
  const run=async(task:()=>Promise<void>)=>{setBusy(true);try{await task();report("PASS");}catch(error){report(`FAIL ${String(error)}`);}finally{setBusy(false);}};
  const sendCases=async()=>{
    for(const [label,body,files,outcome] of [["text","hello",[],"completed"],["image","图片",[attachment],"error"],["attachment-only","",[attachment],"cancelled"],["draft","新会话",[attachment],"completed"],["send-error","失败",[],"transport-error"]] as const){
      select(label==="draft"?"":`case-${++serial}`);await delay(100);sendState=outcome;
      assert(controller.getSnapshot().rows.length===0,`${label}: initial history not empty`);
      const request=send(body,[...files]);request.catch(()=>{});await delay(25);
      const bubble=document.querySelector('[data-conversation-row^="user:"]');assert(bubble,`${label}: missing optimistic bubble`);
      await request.catch(error=>{if(outcome!=="transport-error")throw error;});await delay(160);
      assert(bubble===document.querySelector('[data-conversation-row^="user:"]'),`${label}: bubble remounted`);
      assert(!document.querySelector('.conversation-feed')!.textContent!.includes("暂无对话记录"),`${label}: empty state appeared`);
      if(files.length)assert(controller.getSnapshot().rows.find(row=>row.message?.role==="user")?.message?.attachments?.length===1,`${label}: attachment disappeared`);
      if(outcome!=="transport-error")assert(controller.getSnapshot().rows.find(row=>row.kind==="status")?.status===outcome,`${label}: terminal state missing`);
      report(`${label}: same bubble node, immediate ${outcome}`);
    }
    select(`late-${++serial}`);await delay(100);sendState="completed";const request=send("late reply");await delay(25);select("other");await request;await delay(100);
    assert(controller.getSnapshot().sessionId==="other","late response stole selection");report("late response: selection preserved");
  };
  const longHistory=async()=>{
    const messages:SessionMessage[]=Array.from({length:1000},(_,i)=>({display_group_id:`g${i}`,display_id:`g${i}`,id:`g${i}`,role:"assistant",created_at:i+1,
      content:[{type:"thinking",thinking:`Thought ${i}\n\n${"detail ".repeat(50)}`},{type:"tool_call",id:`tool-${i}`,name:"read",arguments:{path:`fixture-${i}.md`}},{type:"tool_result",tool_call_id:`tool-${i}`,content:"Tool output\n".repeat(100)},
        {type:"text",text:`Message ${i}\n\n**Markdown**. ${"paragraph ".repeat(20)}`}],turn:{turn_id:`turn-${i}`,status:"completed",elapsed_ms:1500}}));
    records.set("long",messages.flatMap(message=>[
      {...message,content:(message.content as unknown[]).slice(0,3)},
      {...message,id:`${message.id}-final`,display_id:`${message.display_id}-final`,content:(message.content as unknown[]).slice(3)},
    ]));select("long");await delay(200);
    let maxMounted=0,maxGroups=0,maxError=0;
    for(let i=0;i<99;i++){
      const root=document.querySelector<HTMLElement>(".conversation-transcript")!;root.scrollTop=Math.min(140,root.scrollHeight-root.clientHeight);root.dispatchEvent(new Event("scroll"));await delay(25);
      const saved=anchor();await current.current.fetchPreviousPage();await delay(140);const drift=anchorError(saved);if(drift>2)report(`anchor page ${i}: ${saved?.id} drift ${drift.toFixed(2)}`);maxError=Math.max(maxError,drift);
      const snapshot=controller.getSnapshot();const groups=new Set([...snapshot.detail!.messages,...snapshot.latest!.messages].map(message=>message.display_group_id));
      maxGroups=Math.max(maxGroups,groups.size);maxMounted=Math.max(maxMounted,document.querySelectorAll("[data-conversation-row]").length);
    }
    assert(controller.getSnapshot().detail!.messages[0]!.display_group_id==="g0","did not reload oldest group");
    // At the top of the reading window, background latest refresh must not move the anchor.
    const saved=anchor();await client.invalidateQueries({queryKey:dashboardQueryKeys.sessions.detailSession("long")});await delay(100);
    assert(anchorError(saved)<=2,"background latest changed reading position");
    const before=controller.getSnapshot().detail;failNextPage=true;await current.current.fetchNextPage().catch(()=>{});await delay();
    assert(controller.getSnapshot().detail===before,"failed pagination discarded window");
    while(current.current.hasNextPage){
      const root=document.querySelector<HTMLElement>(".conversation-transcript")!;
      root.scrollTop=Math.max(0,root.scrollHeight-root.clientHeight-160);root.dispatchEvent(new Event("scroll"));await delay(25);
      await current.current.fetchNextPage();await delay(140);
    }
    assert(controller.getSnapshot().detail!.messages.at(-1)!.display_group_id==="g999","did not reload newest group");
    assert(maxGroups<=60,"combined window exceeds group budget");assert(maxMounted<50,"virtual mounted items not bounded");
    report(`1000 groups: max cached ${maxGroups}, max mounted ${maxMounted}, prepend anchor drift ${maxError.toFixed(3)}px`);
    assert(maxError<=2,"prepend/crop anchor drift exceeds 2px");
  };
  const heightsAndRaces=async()=>{
    if(id!=="long")throw new Error("Run long history first");
    const root=document.querySelector<HTMLElement>(".conversation-transcript")!;
    root.scrollTop=500;root.dispatchEvent(new Event("scroll"));await delay(180);
    // Insert a local image into an already mounted Markdown block, as if its intrinsic
    // height became available after loading. ResizeObserver follows the production path.
    const saved=anchor();
    const earlier=[...root.querySelectorAll<HTMLElement>(".message-markdown")].find(element=>element.getBoundingClientRect().bottom<root.getBoundingClientRect().top);
    assert(earlier,"fixture needs an overscanned Markdown row before the visible anchor");
    const img=document.createElement("img");img.alt="Local fixture image";img.style.cssText="display:block;width:300px;height:30px";
    img.src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='30'%3E%3Crect width='300' height='30' fill='%23ccc'/%3E%3C/svg%3E";
    earlier!.append(img);await delay(160);const afterInsert=anchor();img.style.height="260px";await delay(200);
    const imageError=anchorError(afterInsert);assert(imageError<=2,`image resize anchor error ${imageError}`);img.remove();await delay(160);
    const header=[...root.querySelectorAll<HTMLButtonElement>(".conversation-process-toggle")].find(element=>element.getBoundingClientRect().top>=root.getBoundingClientRect().top);
    assert(header,"missing process header");const headerRow=header!.closest<HTMLElement>("[data-conversation-row]")!;
    const headerAnchor={id:headerRow.dataset.conversationRow!,offset:headerRow.getBoundingClientRect().top-root.getBoundingClientRect().top};
    header!.click();await delay(180);const foldError=anchorError(headerAnchor);assert(foldError<=2,`process expansion drift ${foldError}`);
    const tool=root.querySelector<HTMLButtonElement>(".tool-op-summary");
    assert(tool,"missing real tool summary");
    const toolId=tool!.closest<HTMLElement>("[data-conversation-row]")!.dataset.conversationRow!;
    tool!.click();await delay(160);header!.click();await delay(160);header!.click();await delay(160);
    assert(root.querySelector(`[data-conversation-row="${toolId}"] button`)?.getAttribute("aria-expanded")==="true","tool state reset by process fold");
    const scrollPosition=root.scrollTop;root.scrollTop+=root.clientHeight*10;root.dispatchEvent(new Event("scroll"));await delay(160);
    root.scrollTop=scrollPosition;root.dispatchEvent(new Event("scroll"));await delay(200);
    assert(root.querySelector(`[data-conversation-row="${toolId}"] button`)?.getAttribute("aria-expanded")==="true","tool state lost after virtual remount");
    assert(header!.getAttribute("aria-expanded")==="true","process reopening lost state");
    report(`image growth anchor ${imageError.toFixed(3)}px; process expansion anchor ${foldError.toFixed(3)}px`);
    // A stale page resolves after selection has moved. It must not overwrite the next view.
    pageDelay=180;const obsolete=current.current.fetchPreviousPage();select("race-other");await obsolete;await delay(240);pageDelay=15;
    assert(controller.getSnapshot().sessionId==="race-other"&&controller.getSnapshot().rows.length===0,"old page polluted selection");
    report("late pagination ignored after selection change; tool state survives folds and virtual remount");
    records.set("oversize",[
      {display_group_id:"large",display_id:"large-tool",role:"assistant",content:[{type:"tool_call",id:"huge-tool",name:"read",arguments:{}},{type:"tool_result",tool_call_id:"huge-tool",content:"x".repeat(17*1024*1024)}],turn:{turn_id:"large-turn",status:"completed",elapsed_ms:1}},
      {display_group_id:"large",display_id:"large-final",role:"assistant",content:"Single oversized group retained",turn:{turn_id:"large-turn",status:"completed",elapsed_ms:1}},
    ]);select("oversize");await delay(400);
    const bytes=new TextEncoder().encode(JSON.stringify(controller.getSnapshot().detail!.messages)).byteLength;
    assert(bytes>16*1024*1024&&controller.getSnapshot().detail!.messages_page.group_cursors!.length===1,"oversized single group was truncated");
    report(`oversized group exception: ${bytes} bytes retained, ${document.querySelectorAll("[data-conversation-row]").length} mounted rows`);
  };
  const cacheBudget=async()=>{
    const largeGroup=(group:string,size:number):SessionMessage[]=>[
      {display_group_id:group,display_id:`${group}-tool`,role:"assistant",content:[{type:"tool_call",id:`${group}-call`,name:"read",arguments:{}},{type:"tool_result",tool_call_id:`${group}-call`,content:"x".repeat(size)}],turn:{turn_id:group,status:"completed",elapsed_ms:1}},
      {display_group_id:group,display_id:`${group}-answer`,role:"assistant",content:`Final ${group}`,turn:{turn_id:group,status:"completed",elapsed_ms:1}},
    ];
    records.set("budget",Array.from({length:10},(_,i)=>largeGroup(`budget-${i}`,2*1024*1024)).flat());select("budget");await delay(700);
    const cached=client.getQueryData<SessionDetailPayload>(dashboardQueryKeys.sessions.detail("budget","latest"))!;
    const bytes=new TextEncoder().encode(JSON.stringify(cached.messages)).byteLength;
    assert(bytes<=16*1024*1024,"Query retained uncropped large page");
    report(`Query payload budget: ${bytes} bytes; ${cached.messages_page.group_cursors!.length} groups`);
    records.set("single-large",largeGroup("single",17*1024*1024));select("single-large");await delay(700);
    const large=controller.getSnapshot().detail!;const largeBytes=new TextEncoder().encode(JSON.stringify(large.messages)).byteLength;
    assert(large.messages_page.group_cursors!.length===1&&largeBytes>16*1024*1024,"single large group lost");
    assert(!client.getQueryData(dashboardQueryKeys.sessions.detail("budget","latest")),"old session Query payload remains");
    report(`single oversized group: ${largeBytes} bytes; previous session cache released`);
  };
  return <div style={{height:"100vh",display:"flex",flexDirection:"column"}}>
    <div style={{padding:8,display:"flex",gap:12}}><button disabled={busy} onClick={()=>void run(sendCases)}>Run send scenarios</button><button disabled={busy} onClick={()=>void run(longHistory)}>Run 1000 group history</button>
      <button disabled={busy} onClick={()=>void run(cacheBudget)}>Run cache budget</button>
      <button disabled={busy} onClick={()=>void run(heightsAndRaces)}>Run height and races</button>
      <button disabled={busy} onClick={()=>void run(async()=>{sendState="completed";await send("主动发送回到最新",[]);})}>Send now</button></div>
    <pre id="fixture-report" style={{fontSize:12,maxHeight:145,overflow:"auto",margin:0}}>{reports.join("\n")}</pre>
    <output id="fixture-state">{JSON.stringify({session:id,load:query.display.loadState,connection:query.display.connection,following:query.display.following,groups:query.data?.messages_page.group_cursors?.length,rows:query.display.rows.length,bytes:new TextEncoder().encode(JSON.stringify(query.data?.messages??[])).byteLength})}</output>
    <SessionDetailView fallbackSession={session(id)} detail={query.data??null} activity={query.display.activity??null} display={query.display} pendingMessages={query.display.pending}
      currentModel={null} models={[]} modelLoading={false} modelSaving={false} thinkingSaving={false} newConversation={!id} runtimeReady={true} runtimeUnavailableMessage=""
      loading={query.isPending} error={query.display.error} hasOlder={query.hasPreviousPage} hasNewer={query.hasNextPage} loadingOlder={query.isFetchingPreviousPage}
      loadOlderError={query.isFetchPreviousPageError?String(query.error):""} onLoadOlder={query.fetchPreviousPage} onLoadNewer={query.fetchNextPage} onJumpToLatest={query.jumpToLatest}
      onVisibleGroups={query.setVisibleGroups} onFollowingChange={query.setFollowing} onModelChange={()=>{}} onThinkingLevelChange={()=>{}} onSend={send} onStop={noop} onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop}/>
  </div>;
}
const root=createRoot(document.getElementById("root")!);root.render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);
if(import.meta.hot)import.meta.hot.dispose(()=>root.unmount());
