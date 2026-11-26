import {existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {updateDiagnostic} from "./update-service";
export class UpdateJournal {
 constructor(private path:string){}
 private write(value:unknown):void{
  mkdirSync(dirname(this.path),{recursive:true});
  writeFileSync(this.path+".tmp",JSON.stringify(value),{mode:0o600});
  renameSync(this.path+".tmp",this.path);
 }
 start(version:string,buildId:string):void{this.write({version,build_id:buildId,started_at:new Date().toISOString()});}
 error(error:unknown):void{
  if(!existsSync(this.path))return;
  const record=JSON.parse(readFileSync(this.path,"utf8"));
  this.write({...record,error:updateDiagnostic(error)});
 }
 previous(currentVersion:string,currentBuildId?:string):string|undefined{
  if(!existsSync(this.path))return;
  const record=JSON.parse(readFileSync(this.path,"utf8"));
  if(record.version===currentVersion&&record.build_id===currentBuildId){rmSync(this.path);return "已成功更新到 "+currentVersion;}
  return "上次尝试更新到 "+record.version+"，当前仍为 "+currentVersion+"。"+(record.error||"安装未确认完成，请重新检查更新；不会自动重试安装。");
 }
}
