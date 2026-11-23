import {expect,test} from "bun:test";
import {existsSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";

const cli=resolve(import.meta.dir,"desktop-release.ts");
const wrapper=resolve(import.meta.dir,"publish-desktop-windows.ps1");
const psQuote=(value:string)=>"'"+value.replaceAll("'","''")+"'";

test("publisher CLI consumes piped input, reports invalid JSON and releases its lock",async()=>{
 const root=mkdtempSync(join(tmpdir(),"lxe-publisher-cli-"));
 try{
  const command=process.platform==="win32"
   ?["powershell","-NoLogo","-NoProfile","-Command",`'not-json' | & ${psQuote(process.execPath)} ${psQuote(cli)} publish; exit $LASTEXITCODE`]
   :[process.execPath,cli,"publish"];
  const child=Bun.spawn(command,{env:{...process.env,LOCALAPPDATA:root},stdin:new Blob(["not-json\n"]),stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code).toBe(1);
  expect(stdout).toContain("Reading publisher credentials");
  expect(stderr).toContain('"message":');
  expect(stderr).not.toContain('"secretKey"');
  expect(existsSync(join(root,"LXE","release","publish.lock"))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
},10_000);

for(const success of [false,true])test.skipIf(process.platform!=="win32")(
 `PowerShell publisher ${success?"accepts explicit completion":"rejects silent exit code zero"}`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"lxe publisher wrapper "));
  try{
   const candidate=join(root,"candidate.json");writeFileSync(candidate,"{}");
   const setup=`$ErrorActionPreference='Stop';
$dir=Join-Path $env:LOCALAPPDATA 'LXE\\release'; New-Item -ItemType Directory -Path $dir -Force | Out-Null;
[System.Management.Automation.PSCredential]::new('dummy',(ConvertTo-SecureString 'dummy' -AsPlainText -Force)) | Export-Clixml (Join-Path $dir 'cos-credential.xml');
function bun { $received = ($input | Out-String) | ConvertFrom-Json;
if ($received.secretId -ne 'dummy' -or $received.secretKey -ne 'dummy') { throw 'Credential pipe mismatch'; } ${success?"Write-Output 'Published 0.2.18 / fixture';":""} $global:LASTEXITCODE=0; }
try { & ${psQuote(wrapper)} -Candidate ${psQuote(candidate)}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
   // PowerShell 7 exports its own module path; Windows PowerShell then cannot load
   // Microsoft.PowerShell.Security. Without the variable it uses its defaults.
   const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=="psmodulepath"));
   const child=Bun.spawn(["powershell","-NoLogo","-NoProfile","-Command",setup],{env:{...env,LOCALAPPDATA:root},stdout:"pipe",stderr:"pipe"});
   const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(code).toBe(success?0:1);
   if(success)expect(stdout).toContain("Published 0.2.18 / fixture");
   else expect(stderr).toContain("without confirming completion");
  }finally{rmSync(root,{recursive:true,force:true});}
 },10_000);
