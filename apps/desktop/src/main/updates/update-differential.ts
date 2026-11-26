import {GenericDifferentialDownloader} from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader";
import {parseBlockmap,verifyUpdateFile} from "./update-artifacts";
import {updateDiagnostic,type UpdateTicket} from "./update-service";
type Options=ConstructorParameters<typeof GenericDifferentialDownloader>;
/** true requests a complete download; false means the verified delta was assembled. */
export async function downloadDifferential(options:{
 ticket:UpdateTicket;oldFile:string;newFile:string;newUrl:URL;info:Options[0];transport:Options[1];
 headers:Options[2]["requestHeaders"];cancellationToken:Options[2]["cancellationToken"];
 diagnostic:(message:string)=>void;progress?:Options[2]["onProgress"];
}):Promise<boolean> {
 const d=options.ticket.differential;
 const log=(value:unknown)=>options.diagnostic(updateDiagnostic(value));
 if(!d){log(options.ticket.differential_unavailable??"Installed build or blockmaps unavailable; downloading complete installer");return true;}
 let assembling=false;
 try{
  await verifyUpdateFile(options.oldFile,d.base_release);
  const read=async(artifact:typeof d.old_blockmap,size:number)=>{
   const data=await options.transport.downloadToBuffer(new URL(artifact.url),{cancellationToken:options.cancellationToken,headers:options.headers});
   if(!data)throw new Error("Empty blockmap response");
   return parseBlockmap(data,artifact,size);
  };
  const old=await read(d.old_blockmap,d.base_release.size),next=await read(d.new_blockmap,options.info.size!);
  // The pinned downloader accepts a 200 response to Range and only notices at
  // checksum time. Detect unsupported ranges before consuming their bytes.
  const transport:Options[1]=Object.create(options.transport);
  transport.createRequest=(requestOptions:any,callback:any)=>{
   const request=options.transport.createRequest(requestOptions,(response:any)=>{
    const range=requestOptions.headers?.Range??requestOptions.headers?.range;
    if(range&&response.statusCode<400){
     const match=/^bytes=(\d+)-(\d+)$/.exec(range);
     const expected=match?`bytes ${match[1]}-${match[2]}/${options.info.size}`:undefined;
     if(response.statusCode!==206||String(response.headers["content-range"])!==expected){
      request.emit("error",new Error(`Range unsupported or invalid: HTTP ${response.statusCode}, Content-Range=${String(response.headers["content-range"])}`));
      request.abort();return;
     }
    }
    callback(response);
   });
   return request;
  };
  assembling=true;
  await new GenericDifferentialDownloader(options.info,transport,{
   oldFile:options.oldFile,newFile:options.newFile,newUrl:options.newUrl,requestHeaders:options.headers,
   isUseMultipleRangeRequest:false,cancellationToken:options.cancellationToken,
   logger:{info:log,warn:log,error:log,debug:log},...(options.progress?{onProgress:options.progress}:{}),
  }).download(old,next);
  return false;
 }catch(error){
  if(options.cancellationToken.cancelled)throw error;
  if(assembling && /checksum|sha512/i.test(updateDiagnostic(error)))throw error;
  log("Differential download failed; downloading complete installer: "+updateDiagnostic(error));
  return true;
 }
}
