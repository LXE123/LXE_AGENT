import {app} from "electron";
import {createServer} from "node:http";
import {createReadStream,copyFileSync,existsSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join,basename} from "node:path";
import {strict as assert} from "node:assert";
import {ElectronUpdateInstaller} from "../../src/main/updates/update-electron";
import {DesktopUpdateService,updateDiagnostic,type UpdateTicket} from "../../src/main/updates/update-service";
const record=JSON.parse(readFileSync(process.argv[2]!,"utf8"));
if(!record.appId.startsWith("com.lxe.agent.updatequalification.")||!record.cache.startsWith("lxe-update-qualification-"))throw new Error("Qualification identity required");
app.disableHardwareAcceleration();app.setPath("userData",join(record.output,"download-profile"));
const cache=join(process.env.LOCALAPPDATA!,record.cache);
const hash=async(file:string)=>{const digest=createHash("sha512");for await(const part of createReadStream(file))digest.update(part);return digest.digest("base64");};
void app.whenReady().then(async()=>{
console.log("Native Electron ready; verifying real installer fixtures");
const [oldFile,newFile]=record.artifacts.slice(1);
const describe=async(file:string)=>({file_name:basename(file),size:statSync(file).size,sha512:await hash(file)});
const old={...await describe(oldFile),version:"0.0.2",build_id:record.builds[1],notes:"qualification B"};
const next={...await describe(newFile),version:"0.0.3",build_id:record.builds[2],notes:"qualification C",blockmap:await describe(newFile+".blockmap")};
const oldMap=await describe(oldFile+".blockmap"),newMap=next.blockmap;
let mode="delta",bytes=0,transferBytes=0,ranges=0,completeRequests=0;
const server=createServer((req,res)=>{
 const url=new URL(req.url!,"http://localhost");
 if(url.pathname==="/new.exe"&&mode==="expired"&&url.searchParams.get("generation")==="1"){res.writeHead(403);res.end("Request has expired");return;}
 const source=url.pathname==="/old.blockmap"?oldFile+".blockmap":url.pathname==="/new.blockmap"?newFile+".blockmap":newFile;
 if(mode==="missing-map"&&url.pathname==="/old.blockmap"){res.writeHead(404);res.end("NoSuchKey");return;}
 const size=statSync(source).size,range=/^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range));
 let stream;
 if(range&&mode!=="no-range"){
  ranges++;const start=Number(range[1]),end=Number(range[2]);
  res.writeHead(206,{"Content-Range":`bytes ${start}-${end}/${size}`,"Content-Length":end-start+1});stream=createReadStream(source,{start,end});
 }else{if(source===newFile&&!range)completeRequests++;res.writeHead(200,{"Content-Length":size});stream=createReadStream(source);}
 let tampered=false;
 if(source===newFile)stream.on("data",part=>{bytes+=part.length;if(mode==="bad-target"&&!tampered){part[0]^=255;tampered=true;}});
 stream.on("data",part=>{transferBytes+=part.length;});
 res.on("close",()=>stream.destroy());stream.pipe(res);
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const results:any[]=[];
try{
 for(mode of ["delta","deleted-cache","corrupt-cache","missing-map","no-range","expired","bad-target"]){
  rmSync(join(cache,"pending"),{recursive:true,force:true});mkdirSync(cache,{recursive:true});copyFileSync(oldFile,join(cache,"installer.exe"));
  if(mode==="deleted-cache")rmSync(join(cache,"installer.exe"));
  if(mode==="corrupt-cache")writeFileSync(join(cache,"installer.exe"),"invalid old installer");
  bytes=0;transferBytes=0;ranges=0;completeRequests=0;let tickets=0;
  const diagnostics:string[]=[];
  const installer=new ElectronUpdateInstaller(()=>{},message=>diagnostics.push(message));
  (installer as any).updater.forceDevUpdateConfig=true;
  const api={latest:async()=>({state:"available" as const,release:next}),ticket:async():Promise<UpdateTicket>=>{
   tickets++;const signed=(path:string)=>({url:`${base}/${path}?signature=qualification-secret&generation=${tickets}`,expires_at:Math.floor(Date.now()/1000)+600});
   return {...signed("new.exe"),differential:{base_release:old,old_blockmap:{...oldMap,...signed("old.blockmap")},new_blockmap:{...newMap,...signed("new.blockmap")}}};
  }};
  const service=new DesktopUpdateService({api,installer,supported:true,prepareInstall:async()=>undefined,cleanup:async()=>{throw new Error("Download qualification must never install");}});
  await service.check();const result=await service.download(next);
  if(mode==="bad-target"){
   assert.equal(result.phase,"error");assert.equal(result.failedOperation,"download");assert.match(result.message!,/checksum|sha.?512/i);assert.equal(completeRequests,0);
  }else{
   assert.equal(result.phase,"ready",result.message);
   assert.equal(await hash((installer as any).updater.installerPath),next.sha512);
   if(mode==="delta"){assert(ranges>0);assert(bytes<next.size);assert.equal(completeRequests,0);}
   else if(mode==="expired")assert.equal(tickets,2);
   else assert(completeRequests>0,"Fallback did not download a complete installer");
  }
  assert(!diagnostics.join("\n").includes("qualification-secret"));
  results.push({scenario:mode,phase:result.phase,bytes,transferBytes,installerBytes:next.size,ranges,completeRequests,tickets,diagnostics});
  console.log(JSON.stringify({...results.at(-1),diagnostics:diagnostics.length}));
 }
 writeFileSync(join(record.output,"download-results.json"),JSON.stringify(results,null,2));
 await new Promise<void>(resolve=>server.close(()=>resolve()));app.exit(0);
}catch(error){console.error(updateDiagnostic(error));server.close();app.exit(1);}
}).catch(error=>{console.error(updateDiagnostic(error));app.exit(1);});
