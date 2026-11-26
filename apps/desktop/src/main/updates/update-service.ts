import type {DesktopUpdateArtifact, DesktopUpdateIdentity, DesktopUpdateRelease, DesktopUpdateState} from "@lxe/desktop-protocol";
export interface LatestUpdate {state:"available"|"up_to_date"|"no_release"|"paused";release:DesktopUpdateRelease|null}
export interface SignedArtifact {url:string;expires_at:number}
export interface UpdateTicket extends SignedArtifact {
 differential?: {base_release:DesktopUpdateRelease;old_blockmap:DesktopUpdateArtifact & SignedArtifact;new_blockmap:DesktopUpdateArtifact & SignedArtifact};
 differential_unavailable?:string;
}
export interface UpdateApi { latest():Promise<LatestUpdate>; ticket(release:DesktopUpdateRelease):Promise<UpdateTicket>; }
export interface UpdateInstaller {
 download(release:DesktopUpdateRelease,ticket:UpdateTicket,progress:(percent:number)=>void):Promise<string>;
 verify(file:string,release:DesktopUpdateRelease):Promise<void>;
 install():Promise<void> | void;
}
export class UpdateBusyError extends Error { readonly code = "updates_busy"; }
export const UPDATE_INTERVAL_MS=10*60*1000;
export function nextUpdateDelay(failures:number,random=Math.random):number {
 return Math.min(3_600_000, Math.round(UPDATE_INTERVAL_MS * 2 ** Math.min(failures,3) * (0.8 + random()*0.4)));
}
export function sameIdentity(a:DesktopUpdateIdentity|undefined|null,b:DesktopUpdateIdentity|undefined|null):boolean {
 return !!a&&!!b&&a.version===b.version&&a.build_id===b.build_id;
}
export function sameRelease(a:DesktopUpdateRelease|undefined|null,b:DesktopUpdateRelease|undefined|null):boolean{
 return sameIdentity(a,b)&&a!.sha512===b!.sha512&&a!.size===b!.size;
}
export function updateDiagnostic(error:unknown):string{
 const message=String(error instanceof Error?error.message:error).replace(/https?:\/\/[^\s"<>]+/g,"[URL redacted]");
 return message.slice(0,2000)+(message.length>2000?" [truncated]":"");
}
export class DesktopUpdateService {
 private value:DesktopUpdateState={phase:"idle"};
 private operation:Promise<DesktopUpdateState>|undefined;
 private file:string|undefined;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private stopped=true;
 private failures=0;
 private installing=false;
 constructor(private options:{api:UpdateApi;installer:UpdateInstaller;supported:boolean;
  prepareInstall:()=>Promise<(()=>void)|undefined>;cleanup:()=>Promise<void>;recover?:()=>Promise<void>;
  configured?:()=>boolean;lastAttempt?:string;recordAttempt?:(release:DesktopUpdateRelease)=>void;recordError?:(error:unknown)=>void}){
  if(!options.supported)this.value={phase:"unsupported"};
 }
 state():DesktopUpdateState{return structuredClone({...this.value,...(this.options.lastAttempt?{lastAttempt:this.options.lastAttempt}:{})});}
 // Download/check errors are handled by their promises. Only installer handoff errors
 // occurring outside those operations reach this callback.
 recordFailure(error:unknown):void {
  if(!this.installing&&!this.operation)this.fail(error,"install");
 }
 private fail(error:unknown,failedOperation:NonNullable<DesktopUpdateState["failedOperation"]>):void {
  this.options.recordError?.(error);
  this.value={phase:"error",...(this.value.release?{release:this.value.release}:{}),failedOperation,message:updateDiagnostic(error)};
 }
 start():void{
  if(this.value.phase==="unsupported"||!this.stopped)return;
  this.stopped=false;
  this.schedule(5000+Math.floor(Math.random()*10_000));
 }
 private schedule(delay:number):void {
  if(this.timer)clearTimeout(this.timer);
  if(this.stopped)return;
  this.timer=setTimeout(async()=>{
   if(this.options.configured?.()!==false)await this.check();
   this.schedule(nextUpdateDelay(this.failures));
  },delay);
  this.timer.unref?.();
 }
 wake():void { if(!this.stopped&&!this.operation&&!this.installing)this.schedule(1000); }
 stop():void{this.stopped=true;if(this.timer)clearTimeout(this.timer);}
 private run(action:()=>Promise<void>):Promise<DesktopUpdateState> {
  if(this.operation)return this.operation;
  if(this.value.phase==="unsupported"||this.installing)return Promise.resolve(this.state());
  this.operation=action().then(()=>this.state()).finally(()=>{this.operation=undefined;});
  return this.operation;
 }
 check():Promise<DesktopUpdateState>{return this.run(async()=>{
  const previous=this.value;
  try {
   this.value={phase:"checking",...(previous.release?{release:previous.release}:{})};
   const latest=await this.options.api.latest();
   this.failures=0;
   if(latest.state!=="available"||!latest.release){
    this.file=undefined;
    this.value={phase:latest.state==="paused"?"paused":"idle",message:latest.state==="paused"?"更新发布已暂停":latest.state==="no_release"?"暂未发布更新":"已是最新版本"};
   }else{
    if(!sameRelease(previous.release,latest.release))this.file=undefined;
    this.value={phase:this.file?"ready":"available",release:latest.release};
   }
  }catch(error){this.failures++;this.value=previous;this.fail(error,"check");}
 });}
 download(target:DesktopUpdateIdentity):Promise<DesktopUpdateState>{return this.run(async()=>{
  try{
   const release=this.value.release;
   if(!release||!sameIdentity(target,release))throw new Error("更新目标已变化，请重新检查更新");
   const latest=await this.options.api.latest();
   if(latest.state!=="available"||!sameRelease(latest.release,release))throw new Error("此更新已暂停或被替换，请重新检查更新");
   this.value={phase:"downloading",release,percent:0};
   this.file=undefined;
   for(let attempt=0;attempt<2;attempt++){
    try{
     const ticket=await this.options.api.ticket(release!);
     this.file=await this.options.installer.download(release!,ticket,percent=>{
      this.value={phase:"downloading",release,...(Number.isFinite(percent)?{percent:Math.max(0,Math.min(100,percent))}:{})};
     });
     break;
    }catch(error){
     // Only an expired/denied object URL can renew a ticket. API authorization,
     // checksums and rate limits are terminal, not generic network retry loops.
     if(attempt||!(error instanceof Error&&error.name==="UpdateTicketExpiredError"))throw error;
    }
   }
   if(!this.file)throw new Error("下载未返回安装包");
   this.value={phase:"verifying",release};
   await this.options.installer.verify(this.file,release!);
   this.value={phase:"ready",release};
  }catch(error){this.file=undefined;this.fail(error,"download");}
 });}
 install(target:DesktopUpdateIdentity):Promise<DesktopUpdateState>{return this.run(async()=>{
  let unlock:(()=>void)|undefined;
  let cleanupStarted=false;
  const release=this.value.release;
  try{
   if(!release||!sameIdentity(target,release)||!this.file)throw new Error("已下载的更新目标已变化，请重新检查更新");
   this.value={phase:"preparing",release};
   const latest=await this.options.api.latest();
   if(latest.state!=="available"||!sameRelease(latest.release,release))throw new Error("此更新已暂停或被替换，请重新检查更新");
   await this.options.installer.verify(this.file,release!);
   unlock=await this.options.prepareInstall();
   if(!unlock){this.value={phase:"ready",release};return;}
   // Confirmation may remain open for minutes. Re-authorize after it closes.
   const confirmed=await this.options.api.latest();
   if(confirmed.state!=="available"||!sameRelease(confirmed.release,release))throw new Error("此更新已暂停或被替换，请重新检查更新");
   this.options.recordAttempt?.(release!);
   cleanupStarted=true;
   await this.options.cleanup();
   this.value={phase:"installing",release};
   this.installing=true;
   await this.options.installer.install();
   this.stop();
  }catch(error){
   this.installing=false;
   unlock?.();unlock=undefined;
   if(cleanupStarted)try{await this.options.recover?.();}catch(recovery){error=new Error(updateDiagnostic(error)+"；恢复服务失败："+updateDiagnostic(recovery));}
   this.fail(error,"install");
  }finally{
   if(!this.installing)unlock?.();
  }
 });}
}
