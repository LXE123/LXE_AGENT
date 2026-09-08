import type { SessionRunSummary, SessionStatusSnapshot } from "@lxe/protocol/session-status";
import type { ConversationDisplaySnapshot } from "./display-controller";

export class SessionStatusCache {
  private epoch = "";
  private retired = new Set<string>();
  private revisions = new Map<string,number>();
  private items = new Map<string,SessionRunSummary>();
  private listeners = new Set<()=>void>();
  subscribe = (listener:()=>void) => {this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  getSnapshot = () => this.items;
  receive = (snapshot:SessionStatusSnapshot):void => {
    if(this.retired.has(snapshot.epoch))return;
    const reset=this.epoch!==snapshot.epoch;
    if(reset){if(this.epoch)this.retired.add(this.epoch);this.epoch=snapshot.epoch;this.revisions.clear();this.items=new Map();}
    let next=this.items;
    for(const item of snapshot.items){
      if((this.revisions.get(item.session_id)??-1)>snapshot.revision)continue;
      this.revisions.set(item.session_id,snapshot.revision);
      if(JSON.stringify(next.get(item.session_id))===JSON.stringify(item))continue;
      if(next===this.items)next=new Map(next);
      next.set(item.session_id,item);
    }
    if(reset||next!==this.items){this.items=next;for(const listener of this.listeners)listener();}
  };
}

export function canReadSessionResult(summary:SessionRunSummary|undefined,display:ConversationDisplaySnapshot,visible:boolean,focused:boolean):boolean{
  if(!summary?.result||summary.error||!visible||!focused||display.sessionId!==summary.session_id||display.loadState!=="ready"||!display.detail)return false;
  if(summary.result.state==="unknown")return true;
  if (display.detail.messages.some(message=>message.turn?.turn_id===summary.result!.turn_id&&message.turn.status===summary.result!.state)) return true;
  // A terminal live answer (including an execution error) can be displayed before
  // its transcript refresh. A stream-final alone is insufficient evidence.
  const rows = display.rows.filter(row => row.turnId === summary.result!.turn_id);
  return rows.some(row => row.kind === "status" && row.status === summary.result!.state)
    && rows.some(row => row.message?.role === "assistant");
}
