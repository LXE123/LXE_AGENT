import {NsisUpdater} from "electron-updater";
import {Provider} from "electron-updater/out/providers/Provider";
import {downloadDifferential} from "./update-differential";
import {app,autoUpdater} from "electron";
import {launchUpdateInstaller} from "./update-launch";
import {join} from "node:path";
import type {DesktopUpdateRelease} from "@lxe/desktop-protocol";
import type {UpdateInstaller,UpdateTicket} from "./update-service";
import {updateDiagnostic} from "./update-service";
import {verifyUpdateFile} from "./update-artifacts";
import {UpdateHttpExecutor} from "./update-http-executor";
export {parseUpdateRelease} from "./update-artifacts";
export class PrivateNsisUpdater extends NsisUpdater {
 ticket:UpdateTicket|undefined;
 private readonly transport:UpdateHttpExecutor;
 constructor(private diagnostic:(message:string)=>void){
  super();
  this.transport=new UpdateHttpExecutor((info,callback)=>this.emit("login",info,callback));
  Object.defineProperty(this,"httpExecutor",{value:this.transport});
  this.autoDownload=false;this.autoInstallOnAppQuit=false;
  this.disableDifferentialDownload=false;this.disableWebInstaller=true;this.allowDowngrade=false;
  this.logger=null;
 }
 protected override async differentialDownloadInstaller(fileInfo:any,options:any,destination:string,_provider:any,oldName:string):Promise<boolean> {
  if(!this.ticket||!this.downloadedUpdateHelper)return true;
  return downloadDifferential({ticket:this.ticket,oldFile:join(this.downloadedUpdateHelper.cacheDir,oldName),
   newFile:destination,newUrl:fileInfo.url,info:fileInfo.info,transport:this.transport,
   headers:options.requestHeaders,cancellationToken:options.cancellationToken,
   diagnostic:this.diagnostic,progress:value=>this.emit("download-progress",value)});
 }

 async launchInstaller():Promise<void> {
  const file=this.installerPath;
  if(!file||!this.downloadedUpdateHelper?.downloadedFileInfo)throw new Error("No verified installer available");
  const args=["--updated","/S","--force-run",`/D=${app.getAppPath().replace(/[\\/]resources[\\/]app\.asar$/,"")}`];
  const elevated=()=>launchUpdateInstaller(file,args,true);
  if(this.downloadedUpdateHelper.downloadedFileInfo.isAdminRightsRequired)await elevated();
  else try{await launchUpdateInstaller(file,args);}catch(error){
   if(["EACCES","UNKNOWN"].includes((error as NodeJS.ErrnoException).code??""))await elevated();else throw error;
  }
  // Upstream quitAndInstall quits before asynchronous spawn failures are known.
  // Preserve its installer arguments/events, but only quit after confirmed spawn.
  this.quitAndInstallCalled=true;
  autoUpdater.emit("before-quit-for-update");app.quit();
 }
}
export class ElectronUpdateInstaller implements UpdateInstaller {
 private readonly updater:PrivateNsisUpdater;
 /** cacheReady: startup cache cleanup, which must not race a download into pending. */
 constructor(onError:(error:unknown)=>void=()=>{},diagnostic:(message:string)=>void=()=>{},private cacheReady:Promise<unknown>=Promise.resolve()){
  this.updater=new PrivateNsisUpdater(diagnostic);
  this.updater.on("error",onError);
 }
 async download(release:DesktopUpdateRelease,ticket:UpdateTicket,progress:(percent:number)=>void):Promise<string>{
  await this.cacheReady;
  this.updater.ticket=ticket;
  class PrivateProvider extends Provider<any> {
   constructor(_options:any,_updater:any,runtime:any){super(runtime);}
   async getLatestVersion(){return {version:release.version,files:[{url:release.file_name,size:release.size,sha512:release.sha512}]};}
   resolveFiles(info:any){return [{url:new URL(ticket.url),info:info.files[0]}];}
  }
  this.updater.setFeedURL({provider:"custom",updateProvider:PrivateProvider});
  const listener=(p:any)=>progress(p.percent);
  this.updater.on("download-progress",listener);
  try{
   await this.updater.checkForUpdates();const files=await this.updater.downloadUpdate();
   if(!files?.[0])throw new Error("安装包未下载");return files[0];
  }catch(error){
   // Pinned builder-util-runtime's full-file path drops statusCode and emits
   // this exact message; its buffer/Range paths instead retain HttpError.
   const deniedDownload=error instanceof Error&&/^Cannot download "https?:\/\/[^"\r\n]+", status 403: /.test(error.message);
   if((error as any)?.statusCode===403||deniedDownload){
    const expired=new Error(updateDiagnostic(error));expired.name="UpdateTicketExpiredError";throw expired;
   }
   throw error;
  }finally{this.updater.removeListener("download-progress",listener);}
 }
 verify=verifyUpdateFile;
 install():Promise<void>{return this.updater.launchInstaller();}
}
