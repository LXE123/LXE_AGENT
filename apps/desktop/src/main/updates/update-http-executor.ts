import {ElectronHttpExecutor} from "electron-updater/out/electronHttpExecutor";
import type {ClientRequest,IncomingMessage} from "electron";
/** Bound stalled Electron requests without imposing a total download time limit. */
export class UpdateHttpExecutor extends ElectronHttpExecutor {
 override addErrorAndTimeoutHandlers(request:ClientRequest,reject:(error:Error)=>void):void {
  super.addErrorAndTimeoutHandlers(request,reject,60_000);
  let response:IncomingMessage|undefined,timer:ReturnType<typeof setTimeout>;
  const stop=()=>{
   clearTimeout(timer);request.off("response",received);request.off("abort",stop);request.off("error",stop);
   response?.off("data",refresh);response?.off("end",stop);response?.off("error",stop);
  };
  const refresh=()=>{clearTimeout(timer);timer=setTimeout(()=>{stop();reject(new Error("Update HTTP connection idle for 60000 ms"));request.abort();},60_000);};
  const received=(value:IncomingMessage)=>{response=value;value.on("data",refresh);value.once("end",stop);value.once("error",stop);refresh();};
  request.once("response",received);request.once("abort",stop);request.once("error",stop);refresh();
 }
}
