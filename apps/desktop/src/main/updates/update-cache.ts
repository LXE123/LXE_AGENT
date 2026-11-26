import {existsSync,readFileSync} from "node:fs";
import {rm} from "node:fs/promises";
import {join} from "node:path";
import {updateDiagnostic} from "./update-service";

/** Must match resources/app-update.yml; installer.exe there is the differential base. */
export const UPDATE_CACHE_DIR="lxe-agent-updater";
/** Builds before the 2026-09 updater used the scoped package name; nothing reads it now. */
const LEGACY_CACHE_DIRS=["@lxedesktop-updater"];
const PENDING_INSTALLER=/^LXE-Agent-(\d+)\.(\d+)\.(\d+)-windows-x64\.exe$/;

function newerThan(fileName:unknown,current:string):boolean{
 const pending=typeof fileName==="string"?PENDING_INSTALLER.exec(fileName):null;
 const installed=/^(\d+)\.(\d+)\.(\d+)$/.exec(current);
 if(!pending||!installed)return false;
 for(let i=1;i<=3;i++){const a=Number(pending[i]),b=Number(installed[i]);if(a!==b)return a>b;}
 return false;
}

export interface UpdateCacheCleanup {removed:string[];failed:{path:string;error:string}[]}

/**
 * Removes installers nothing will use again: a pending download that is not newer
 * than the running version (installed already or superseded) and legacy caches.
 * A newer pending download is kept so an update postponed with "later" is not
 * downloaded again. Failures are reported and never block startup.
 */
export async function cleanUpdateCache(cacheRoot:string,currentVersion:string):Promise<UpdateCacheCleanup>{
 const targets=LEGACY_CACHE_DIRS.map(name=>join(cacheRoot,name)).filter(path=>existsSync(path));
 const pending=join(cacheRoot,UPDATE_CACHE_DIR,"pending");
 if(existsSync(pending)){
  let fileName:unknown;
  try{fileName=JSON.parse(readFileSync(join(pending,"update-info.json"),"utf8")).fileName;}catch{}
  if(!newerThan(fileName,currentVersion))targets.push(pending);
 }
 const result:UpdateCacheCleanup={removed:[],failed:[]};
 for(const path of targets){
  try{await rm(path,{recursive:true,force:true});result.removed.push(path);}
  catch(error){result.failed.push({path,error:updateDiagnostic(error)});}
 }
 return result;
}
