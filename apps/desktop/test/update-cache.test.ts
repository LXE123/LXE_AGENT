import {test,expect} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cleanUpdateCache,UPDATE_CACHE_DIR} from "../src/main/update-cache";

function fixture(pendingInfo?:string){
 const root=mkdtempSync(join(tmpdir(),"lxe-update-cache-"));
 const cache=join(root,UPDATE_CACHE_DIR),pending=join(cache,"pending");
 mkdirSync(pending,{recursive:true});writeFileSync(join(cache,"installer.exe"),"base");
 if(pendingInfo!==undefined){writeFileSync(join(pending,"update-info.json"),pendingInfo);writeFileSync(join(pending,"LXE-Agent-x.exe"),"pending");}
 return {root,cache,pending};
}
const info=(version:string)=>JSON.stringify({fileName:`LXE-Agent-${version}-windows-x64.exe`,sha512:"x",isAdminRightsRequired:false});

test("cache directory matches the packaged updater configuration",()=>{
 expect(readFileSync(join(import.meta.dir,"../resources/app-update.yml"),"utf8")).toContain(`updaterCacheDirName: ${UPDATE_CACHE_DIR}\n`);
});

test("installed, older and unreadable pending downloads are removed while the differential base stays",async()=>{
 for(const [pendingInfo,current] of [[info("0.3.7"),"0.3.7"],[info("0.3.4"),"0.3.7"],[info("0.3.10"),"0.3.10"],["{broken","0.3.7"],[JSON.stringify({fileName:"other.exe"}),"0.3.7"],["","0.3.7"]] as const){
  const f=fixture(pendingInfo||undefined);
  try{
   const result=await cleanUpdateCache(f.root,current);
   expect(result).toEqual({removed:[f.pending],failed:[]});
   expect(existsSync(f.pending)).toBe(false);
   expect(readFileSync(join(f.cache,"installer.exe"),"utf8")).toBe("base");
  }finally{rmSync(f.root,{recursive:true,force:true});}
 }
});

test("a newer postponed download is kept for installation",async()=>{
 for(const [version,current] of [["0.3.8","0.3.7"],["0.4.0","0.3.12"],["0.3.10","0.3.9"]]){
  const f=fixture(info(version!));
  try{
   expect(await cleanUpdateCache(f.root,current!)).toEqual({removed:[],failed:[]});
   expect(existsSync(join(f.pending,"update-info.json"))).toBe(true);
  }finally{rmSync(f.root,{recursive:true,force:true});}
 }
});

test("legacy installer cache is removed once and missing directories are not reported",async()=>{
 const root=mkdtempSync(join(tmpdir(),"lxe-update-cache-"));
 try{
  const legacy=join(root,"@lxedesktop-updater");mkdirSync(legacy);writeFileSync(join(legacy,"installer.exe"),"old");
  expect(await cleanUpdateCache(root,"0.3.7")).toEqual({removed:[legacy],failed:[]});
  expect(existsSync(legacy)).toBe(false);
  expect(await cleanUpdateCache(root,"0.3.7")).toEqual({removed:[],failed:[]});
 }finally{rmSync(root,{recursive:true,force:true});}
});
