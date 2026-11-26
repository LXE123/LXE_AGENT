import {createRequire} from "node:module";
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {launchUpdateInstaller} from "../apps/desktop/src/main/updates/update-launch";

if(process.platform!=="win32")throw new Error("Run native updater qualification on Windows");
const path=resolve(process.argv[2]??"");
const record=JSON.parse(readFileSync(path,"utf8"));
if(!record.appId.startsWith("com.lxe.agent.updatequalification.")||!record.cache.startsWith("lxe-update-qualification-"))throw new Error("Qualification identity required");
const folder=join(record.output,"download-app");mkdirSync(folder,{recursive:true});
record.cache=record.cache.replace(/-updater$/,"-download-updater");
const downloadRecord=join(folder,"qualification.json");writeFileSync(downloadRecord,JSON.stringify(record));
// Exercise ShellExecute's acknowledged launch with a harmless real process,
// including spaces/Unicode in the argument and no change to a real application.
const probe=join(folder,"提权 launch.txt");
rmSync(probe,{force:true});
await launchUpdateInstaller(join(record.output,"payload/resources/runtime/node/node.exe"),["-e",`require('node:fs').writeFileSync(${JSON.stringify(probe)},'started')`],true);
const deadline=Date.now()+10000;
while(!existsSync(probe)&&Date.now()<deadline)await Bun.sleep(50);
if(!existsSync(probe)||readFileSync(probe,"utf8")!=="started")throw new Error("Elevated launch did not execute its test payload");
console.log("PASS elevated installer handoff waits for confirmed launch and preserves Unicode/space arguments");
if(process.argv[3]==="--launch-only")process.exit(0);
const result=await Bun.build({entrypoints:[resolve("apps/desktop/test/fixtures/update-download.electron.ts")],outdir:folder,naming:"index.js",target:"node",format:"esm",external:["electron"]});
if(!result.success)throw new AggregateError(result.logs,"Failed to bundle native updater fixture");
writeFileSync(join(folder,"package.json"),JSON.stringify({name:record.cache.replace(/-updater$/,""),version:"0.0.2",type:"module",main:"index.js"}));
writeFileSync(join(folder,"dev-app-update.yml"),`updaterCacheDirName: ${record.cache}\n`);
const require=createRequire(resolve("apps/desktop/package.json")),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=Bun.spawn([require("electron"),folder,downloadRecord],{env,stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
