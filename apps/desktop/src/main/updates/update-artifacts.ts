import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {gunzipSync} from "node:zlib";
import type {DesktopUpdateArtifact,DesktopUpdateRelease} from "@lxe/desktop-protocol";
export const COS_HOST="lxe-agent-updates-1317107914.cos.ap-guangzhou.myqcloud.com";
export function parseUpdateArtifact(value:any,name:string,maxSize=16*1024**3):DesktopUpdateArtifact {
 if(!value||value.file_name!==name||!Number.isSafeInteger(value.size)||value.size<=0||value.size>maxSize
  ||typeof value.sha512!=="string"||!/^[A-Za-z0-9+/]{86}==$/.test(value.sha512))throw new Error("服务器返回的更新文件记录无效");
 return {file_name:name,size:value.size,sha512:value.sha512};
}
export function parseUpdateRelease(value:any):DesktopUpdateRelease {
 if(!value||typeof value.version!=="string"||! /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
  ||typeof value.build_id!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(value.build_id)
  ||typeof value.notes!=="string"||value.notes.length>32768)throw new Error("服务器返回的更新记录无效");
 const artifact=parseUpdateArtifact(value,"LXE-Agent-"+value.version+"-windows-x64.exe");
 return {...artifact,version:value.version,build_id:value.build_id,notes:value.notes,
  ...(value.blockmap?{blockmap:parseUpdateArtifact(value.blockmap,artifact.file_name+".blockmap",16*1024**2)}:{})};
}
export function parseSignedArtifact(value:any,key:string):{url:string;expires_at:number} {
 const url=new URL(value.url);
 if(url.protocol!=="https:"||url.hostname!==COS_HOST||url.port||url.username||url.password||url.hash
  ||decodeURIComponent(url.pathname)!="/artifacts/"+key
  ||!Number.isSafeInteger(value.expires_at)||value.expires_at<=Date.now()/1000)throw new Error("下载链接或有效期无效");
 return {url:url.toString(),expires_at:value.expires_at};
}
export async function verifyUpdateFile(file:string,artifact:DesktopUpdateArtifact):Promise<void> {
 if((await stat(file)).size!==artifact.size)throw new Error("更新文件大小校验失败："+artifact.file_name);
 const hash=createHash("sha512");
 for await(const part of createReadStream(file))hash.update(part);
 if(hash.digest("base64")!==artifact.sha512)throw new Error("更新文件 SHA-512 校验失败："+artifact.file_name);
}
export function parseBlockmap(data:Buffer,artifact:DesktopUpdateArtifact,installerSize:number):any {
 if(data.length!==artifact.size||createHash("sha512").update(data).digest("base64")!==artifact.sha512)throw new Error("Blockmap SHA-512/size mismatch: "+artifact.file_name);
 const map=JSON.parse(gunzipSync(data,{maxOutputLength:64*1024**2}).toString("utf8"));
 if(typeof map.version!=="string"||!Array.isArray(map.files)||!map.files.length)throw new Error("Invalid blockmap header");
 let previousEnd=0;
 for(const file of map.files){
  if(typeof file.name!=="string"||!Array.isArray(file.sizes)||!Array.isArray(file.checksums)||file.sizes.length!==file.checksums.length
   ||!Number.isSafeInteger(file.offset)||file.offset<previousEnd)throw new Error("Invalid blockmap file");
  let end=file.offset;
  for(let i=0;i<file.sizes.length;i++){
   if(!Number.isSafeInteger(file.sizes[i])||file.sizes[i]<=0||typeof file.checksums[i]!=="string")throw new Error("Invalid blockmap block");
   end+=file.sizes[i];
   if(!Number.isSafeInteger(end)||end>installerSize)throw new Error("Blockmap exceeds installer");
  }
  previousEnd=end;
 }
 return map;
}
