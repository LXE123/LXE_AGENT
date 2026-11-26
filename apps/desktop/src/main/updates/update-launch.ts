import {spawn} from "node:child_process";
import {join} from "node:path";

/** Resolve only after the installer itself starts, including an accepted UAC prompt. */
export function launchUpdateInstaller(file:string,args:string[],elevated=false,spawnProcess:typeof spawn=spawn):Promise<void>{
 const quote=(value:string)=>'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/\\+$/g,'$&$&')+'"';
 const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 const script=`$ErrorActionPreference='Stop'
try {
 $child=Start-Process -FilePath ${literal(file)} -ArgumentList ${literal(args.map(quote).join(" "))} -Verb RunAs -PassThru
 if ($null -eq $child -or $child.Id -le 0) { throw 'ShellExecute did not return an installer process' }
 [Console]::Out.WriteLine('LXE_INSTALLER_STARTED='+$child.Id)
 exit 0
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }`;
 return new Promise((resolve,reject)=>{
  const child=elevated
   ?spawnProcess(join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,stdio:["ignore","pipe","pipe"]})
   :spawnProcess(file,args,{detached:true,stdio:"ignore"});
  child.once("error",reject);
  if(!elevated){child.once("spawn",()=>{child.unref();resolve();});return;}
  let stdout="",stderr="";
  child.stdout?.on("data",value=>{stdout=(stdout+value).slice(-16384);});
  child.stderr?.on("data",value=>{stderr=(stderr+value).slice(-16384);});
  child.once("close",(code,signal)=>{
   if(code===0&&/LXE_INSTALLER_STARTED=\d+/.test(stdout))resolve();
   else reject(new Error(`Elevated installer launch failed (exit=${code}, signal=${signal}): ${stderr||stdout}`));
  });
 });
}
