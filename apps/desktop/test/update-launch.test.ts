import {test,expect} from "bun:test";
import {EventEmitter} from "node:events";
import type {spawn} from "node:child_process";
import {launchUpdateInstaller} from "../src/main/updates/update-launch";
function fixture(){
 const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),unref(){}});
 return {child,spawn:(()=>child) as unknown as typeof spawn};
}
test("direct spawn errors remain failures and do not complete the handoff",async()=>{
 const f=fixture();const result=launchUpdateInstaller("missing.exe",[],false,f.spawn);
 f.child.emit("error",new Error("spawn ENOENT"));await expect(result).rejects.toThrow("spawn ENOENT");
});
test("elevated handoff waits for actual installer confirmation, not the helper spawn",async()=>{
 const f=fixture();let done=false;
 const result=launchUpdateInstaller("installer.exe",["/S"],true,f.spawn).then(()=>{done=true;});
 f.child.emit("spawn");await Promise.resolve();expect(done).toBe(false);
 f.child.stdout.emit("data",Buffer.from("LXE_INSTALLER_STARTED=4321\r\n"));f.child.emit("close",0,null);
 await result;expect(done).toBe(true);
});
test("UAC rejection keeps the actual ShellExecute error for recovery",async()=>{
 const f=fixture();const result=launchUpdateInstaller("installer.exe",[],true,f.spawn);
 f.child.emit("spawn");f.child.stderr.emit("data",Buffer.from("Win32Exception (1223): The operation was canceled by the user"));f.child.emit("close",1,null);
 await expect(result).rejects.toThrow("Win32Exception (1223)");
});
