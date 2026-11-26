import type {DesktopCloudState,DesktopUpdateIdentity,DesktopUpdateRelease} from "@lxe/desktop-protocol";
import type {LatestUpdate,UpdateApi,UpdateTicket} from "./update-service";
import {sameIdentity,updateDiagnostic} from "./update-service";
import {parseUpdateArtifact,parseUpdateRelease,parseSignedArtifact} from "./update-artifacts";

type UpdateCloudState = Pick<DesktopCloudState,"device_context"|"native_access">;

// Business discovery resolves the company address even without legacy enrollment.
// Use the same readiness rule for polling and network recovery notifications.
export function updateConnectionReady(state:UpdateCloudState):boolean {
 return Boolean(state.device_context?.server_url) && !state.device_context?.pending_device
  && state.native_access?.status === "connected";
}

export class UpdateConnectionMonitor {
 private ready=false;
 restored(state:UpdateCloudState):boolean {
  if(!state.device_context?.server_url || state.device_context.pending_device
   || ["offline","denied","error"].includes(state.native_access?.status ?? "")) {
   this.ready=false;return false;
  }
  // Periodic cloud probes transiently enter pending/checking without going offline.
  if(!updateConnectionReady(state))return false;
  const restored=!this.ready;this.ready=true;return restored;
 }
}

export class DesktopUpdateApi implements UpdateApi{
 constructor(private cloud:()=>UpdateCloudState,private version:string,private buildId?:string,
  private request:(url:URL,init:RequestInit)=>Promise<Response> = (url,init)=>fetch(url,init)){}
 private async call(path:string,body?:unknown):Promise<any>{
  const state=this.cloud();
  if(state.device_context?.pending_device)throw new Error("设备身份已变化，请先确认当前设备后再检查更新");
  const server=state.device_context?.server_url;
  if(!server)throw new Error("更新服务地址为空，无法检查更新");
  const base=new URL(server);
  if(base.protocol!=="http:"||base.hostname!=="10.88.0.1"||base.port!=="8000"||base.username||base.password)throw new Error("更新服务地址必须是已配置的公司 WireGuard 服务");
  const response=await this.request(new URL("/api/v1/desktop-updates/"+path,base),{
   method:body?"POST":"GET",headers:{"X-LXE-Client":"cli",...(body?{"Content-Type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),redirect:"error",
  });
  const text=await response.text();
  if(text.length>131072)throw new Error("更新服务响应超过大小限制");
  let result:any;try{result=JSON.parse(text);}catch{throw new Error("更新服务返回非 JSON 响应："+response.status+" "+updateDiagnostic(text));}
  if(!response.ok)throw new Error("HTTP "+response.status+" "+updateDiagnostic(JSON.stringify(result.detail??result))+
   (response.headers.has("Retry-After")?"；请在 "+response.headers.get("Retry-After")+" 秒后重试":""));
  return result;
 }
 async latest():Promise<LatestUpdate>{
  const result=await this.call("latest?platform=windows-x64&current_version="+encodeURIComponent(this.version));
  if(!["available","up_to_date","paused","no_release"].includes(result.state))throw new Error("未知更新状态");
  return {state:result.state,release:result.release?parseUpdateRelease(result.release):null};
 }
 async ticket(release:DesktopUpdateRelease):Promise<UpdateTicket>{
  const base:DesktopUpdateIdentity|undefined=this.buildId?{version:this.version,build_id:this.buildId}:undefined;
  const result=await this.call("download",{version:release.version,build_id:release.build_id,platform:"windows-x64",
   ...(release.blockmap&&base?{include_blockmaps:true,base_release:base}:{})});
  const key=(r:DesktopUpdateIdentity,name:string)=>r.version+"/"+r.build_id+"/"+name;
  const ticket:UpdateTicket={...parseSignedArtifact(result,key(release,release.file_name))};
  if(result.differential_unavailable)ticket.differential_unavailable=updateDiagnostic(result.differential_unavailable);
  if(result.differential){
   const d=result.differential,old=parseUpdateRelease(d.base_release);
   if(!base||!sameIdentity(old,base)||!release.blockmap)throw new Error("差分基础版本与本机不匹配");
   const oldMap=parseUpdateArtifact(d.old_blockmap,old.file_name+".blockmap",16*1024**2);
   const newMap=parseUpdateArtifact(d.new_blockmap,release.blockmap.file_name,16*1024**2);
   if(newMap.size!==release.blockmap.size||newMap.sha512!==release.blockmap.sha512)throw new Error("差分目标元数据发生变化");
   ticket.differential={base_release:old,
    old_blockmap:{...oldMap,...parseSignedArtifact(d.old_blockmap,key(old,oldMap.file_name))},
    new_blockmap:{...newMap,...parseSignedArtifact(d.new_blockmap,key(release,newMap.file_name))}};
  }
  return ticket;
 }
}
