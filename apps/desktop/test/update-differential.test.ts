import {expect,test} from "bun:test";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {createServer,request} from "node:http";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {downloadDifferential} from "../src/main/updates/update-differential";
import {parseSignedArtifact,parseUpdateRelease} from "../src/main/updates/update-artifacts";
import type {UpdateTicket} from "../src/main/updates/update-service";
const require=createRequire(import.meta.url);
const updaterRequire=createRequire(require.resolve("electron-updater/package.json"));
const {HttpExecutor,CancellationToken}=updaterRequire("builder-util-runtime");
class NodeExecutor extends HttpExecutor {
 createRequest(options:any,callback:any){return request(options,callback);}
 addRedirectHandlers(){}
}
const hash=(b:Buffer)=>createHash("sha512").update(b).digest("base64");
const artifact=(file_name:string,data:Buffer)=>({file_name,size:data.length,sha512:hash(data)});
async function fixture(mode="range"){
 const old=Buffer.alloc(1024*1024);for(let i=0;i<old.length;i++)old[i]=((i*7)^(i>>11))%256;
 const next=Buffer.from(old);next.fill(137,16*32768,17*32768);
 const map=(data:Buffer)=>gzipSync(Buffer.from(JSON.stringify({version:"2",files:[{name:"file",offset:0,
  sizes:Array(32).fill(32768),checksums:Array.from({length:32},(_,i)=>hash(data.subarray(i*32768,(i+1)*32768)))}]})));
 const oldMap=map(old),newMap=map(next),root=mkdtempSync(join(tmpdir(),"lxe-delta-"));
 let transferred=0,ranges=0;
 const server=createServer((req,res)=>{
  if(req.url==="/old.blockmap"){if(mode==="missing-map"){res.writeHead(404);res.end("NoSuchKey");}else res.end(oldMap);return;}
  if(req.url==="/new.blockmap"){res.end(newMap);return;}
  const m=/bytes=(\d+)-(\d+)/.exec(String(req.headers.range));
  if(m&&mode!=="no-range"){
   ranges++;const start=Number(m[1]),end=Number(m[2]);res.writeHead(206,{"Content-Range":`bytes ${start}-${end}/${next.length}`,"Content-Length":end-start+1});
   const bytes=Buffer.from(next.subarray(start,end+1));if(mode==="bad-target")bytes[0]^=255;
   transferred+=bytes.length;res.end(bytes);
  }else{transferred+=next.length;res.writeHead(200,{"Content-Length":next.length});res.end(next);}
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const ticket:UpdateTicket={url:base+"/new.exe",expires_at:2**32,differential:{
  base_release:{...artifact("old.exe",old),version:"0.2.18",build_id:"old",notes:"old"},
  old_blockmap:{...artifact("old.exe.blockmap",oldMap),url:base+"/old.blockmap",expires_at:2**32},
  new_blockmap:{...artifact("new.exe.blockmap",newMap),url:base+"/new.blockmap",expires_at:2**32}}};
 const oldFile=join(root,"installer.exe"),newFile=join(root,"new.exe");writeFileSync(oldFile,old);
 const diagnostics:string[]=[];
 const run=()=>downloadDifferential({ticket,oldFile,newFile,newUrl:new URL(ticket.url),info:artifact("new.exe",next),transport:new NodeExecutor(),headers:null,cancellationToken:new CancellationToken(),diagnostic:m=>diagnostics.push(m)});
 return {run,oldFile,newFile,next,diagnostics,stats:()=>({transferred,ranges}),close:async()=>{await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}};
}
test("upstream differential algorithm reconstructs identical bytes with single-range traffic",async()=>{
 const f=await fixture();try{expect(await f.run()).toBe(false);expect(readFileSync(f.newFile)).toEqual(f.next);expect(f.stats().ranges).toBeGreaterThan(0);expect(f.stats().transferred).toBeLessThan(f.next.length/2);}finally{await f.close();}
});
test.each(["deleted-cache","corrupt-cache","missing-map","no-range"])("complete download fallback preserves a real reason: %s",async mode=>{
 const f=await fixture(mode);try{if(mode==="deleted-cache")rmSync(f.oldFile);if(mode==="corrupt-cache")writeFileSync(f.oldFile,"bad");
 expect(await f.run()).toBe(true);expect(f.diagnostics.at(-1)).toContain("Differential download failed");
 }finally{await f.close();}
});
test("target SHA failure is terminal",async()=>{
 const f=await fixture("bad-target");try{await expect(f.run()).rejects.toThrow(/checksum|sha512/i);}finally{await f.close();}
});
test("signed URLs cannot redirect tickets to another artifact or host",()=>{
 const value={url:"https://lxe-agent-updates-1317107914.cos.ap-guangzhou.myqcloud.com/artifacts/0.2.18/old/a.exe?signature=test",expires_at:2**32};
 expect(parseSignedArtifact(value,"0.2.18/old/a.exe").url).toContain("signature=test");
 expect(()=>parseSignedArtifact(value,"0.2.18/new/a.exe")).toThrow();
 expect(()=>parseSignedArtifact({...value,url:"https://example.com/artifacts/0.2.18/old/a.exe"},"0.2.18/old/a.exe")).toThrow();
 expect(()=>parseSignedArtifact({...value,expires_at:0},"0.2.18/old/a.exe")).toThrow();
});
test("release parser accepts legacy manifests and validates optional blockmaps",()=>{
 const raw={...artifact("LXE-Agent-0.2.18-windows-x64.exe",Buffer.from("exe")),version:"0.2.18",build_id:"old",notes:"notes"};
 expect(parseUpdateRelease(raw).blockmap).toBeUndefined();
 const blockmap=artifact(raw.file_name+".blockmap",Buffer.from("map"));
 expect(parseUpdateRelease({...raw,blockmap}).blockmap).toEqual(blockmap);
 expect(()=>parseUpdateRelease({...raw,blockmap:{...blockmap,file_name:"../else"}})).toThrow();
});
