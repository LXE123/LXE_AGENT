import {expect,test} from "bun:test";
import {DesktopUpdateService,updateDiagnostic,nextUpdateDelay,type LatestUpdate} from "../src/main/update-service";
import {prepareUpdate} from "../src/main/update-preparation";
import type {DesktopUpdateRelease} from "@lxe/desktop-protocol";
const release:DesktopUpdateRelease={version:"0.2.18",build_id:"one",file_name:"LXE-Agent-0.2.18-windows-x64.exe",size:3,sha512:"hash",notes:"notes"};
function fixture(){
 const calls:string[]=[];
 let latest:LatestUpdate={state:"available",release};
 let verificationFailure=false,cleanupFailure=false,cancel=false,downloadFailures=0,installFailure=false,revoked=false;
 let afterConfirm=()=>{};
 const service=new DesktopUpdateService({
  supported:true,
  api:{latest:async()=>{calls.push("latest");if(revoked)throw new Error("HTTP 403 device_disabled");return latest;},ticket:async()=>{calls.push("ticket");return {url:"https://private/file?signature=secret",expires_at:99999};}},
  installer:{download:async(_r,_u,progress)=>{calls.push("download");if(downloadFailures-->0){const e=new Error("object URL expired");e.name="UpdateTicketExpiredError";throw e;}progress(42);return "cache.exe";},
   verify:async()=>{calls.push("verify");if(verificationFailure)throw new Error("SHA512 checksum mismatch");},
   install:async()=>{calls.push("install");if(installFailure)throw new Error("spawn ENOENT");}},
  prepareInstall:async()=>{calls.push("confirm+fence");if(cancel)return;afterConfirm();return ()=>{calls.push("unlock");};},
  cleanup:async()=>{calls.push("cleanup");if(cleanupFailure)throw new Error("runtime did not exit");},
  recover:async()=>{calls.push("recover");},
 });
 return {service,calls,pause:()=>{latest={state:"paused",release:null};},replace:()=>{latest={state:"available",release:{...release,build_id:"two"}};},
  bad:()=>{verificationFailure=true;},cancel:()=>{cancel=true;},cleanupFail:()=>{cleanupFailure=true;},downloadFail:(n:number)=>{downloadFailures=n;},installFail:()=>{installFailure=true;},
  revoke:()=>{revoked=true;},afterConfirm:(action:()=>void)=>{afterConfirm=action;},
  ready:async()=>{await service.check();return service.download(release);}};
}
test("automatic check only advertises a release; download requires a bound user action",async()=>{
 const f=fixture();
 expect((await f.service.check()).phase).toBe("available");expect(f.calls).toEqual(["latest"]);
 expect((await f.service.download(release)).phase).toBe("ready");expect(f.calls).not.toContain("install");
});
test.each(["pause","replace","revoke"] as const)("changes while native consent is open block installation: %s",async action=>{
 const f=fixture();await f.ready();f.afterConfirm(f[action]);
 const state=await f.service.install(release);
 expect(state.failedOperation).toBe("install");expect(f.calls).toContain("unlock");
 expect(f.calls).not.toContain("cleanup");expect(f.calls).not.toContain("install");
 if(action==="revoke")expect(state.message).toContain("HTTP 403 device_disabled");
});
test("ready cached package survives rechecks without a ticket",async()=>{
 const f=fixture();await f.ready();await f.service.check();expect(f.service.state().phase).toBe("ready");
 expect(f.calls.filter(x=>x==="ticket")).toHaveLength(1);
});
test("installation re-authorizes after confirmation and fences before cleanup",async()=>{
 const f=fixture();await f.ready();f.calls.length=0;await f.service.install(release);
 expect(f.calls).toEqual(["latest","verify","confirm+fence","latest","cleanup","install"]);
});
test.each(["pause","replace"] as const)("withdrawn/replaced release cannot install: %s",async action=>{
 const f=fixture();await f.ready();f[action]();expect((await f.service.install(release)).failedOperation).toBe("install");
 expect(f.calls).not.toContain("confirm+fence");expect(f.calls).not.toContain("install");
});
test("stale download and install consent cannot act on another build",async()=>{
 const f=fixture();await f.ready();f.replace();await f.service.check();f.calls.length=0;
 await f.service.download(release);await f.service.install(release);
 expect(f.calls).toEqual([]);
});
test("declining native confirmation preserves the prepared package",async()=>{
 const f=fixture();await f.ready();f.cancel();expect((await f.service.install(release)).phase).toBe("ready");
 expect(f.calls).not.toContain("cleanup");expect(f.calls).not.toContain("install");
});
test.each(["cleanupFail","installFail"] as const)("failed handoff retains release and recovers services: %s",async kind=>{
 const f=fixture();await f.ready();f[kind]();const s=await f.service.install(release);
 expect(s.release).toEqual(release);expect(s.failedOperation).toBe("install");expect(f.calls).toContain("unlock");expect(f.calls).toContain("recover");
 expect(f.calls.indexOf("unlock")).toBeLessThan(f.calls.indexOf("recover"));
});
test("package corrupted after download is rejected before closing app",async()=>{
 const f=fixture();await f.ready();f.bad();await f.service.install(release);
 expect(f.calls).not.toContain("cleanup");expect(f.calls).not.toContain("install");
});
test("expired URL gets one renewal, never unbounded retry",async()=>{
 const f=fixture();f.downloadFail(1);expect((await f.ready()).phase).toBe("ready");
 expect(f.calls.filter(x=>x==="ticket")).toHaveLength(2);
 const g=fixture();g.downloadFail(20);expect((await g.ready()).failedOperation).toBe("download");
 expect(g.calls.filter(x=>x==="ticket")).toHaveLength(2);
});
test("concurrent checks and downloads coalesce",async()=>{
 const f=fixture();await Promise.all([f.service.check(),f.service.check()]);
 expect(f.calls.filter(x=>x==="latest")).toHaveLength(1);
 await Promise.all([f.service.download(release),f.service.download(release)]);
 expect(f.calls.filter(x=>x==="download")).toHaveLength(1);
});
test("polling jitter and failures respect one-hour maximum",()=>{
 expect(nextUpdateDelay(0,()=>0)).toBe(480000);expect(nextUpdateDelay(0,()=>1)).toBe(720000);
 expect(nextUpdateDelay(1,()=>0.5)).toBe(1200000);expect(nextUpdateDelay(99,()=>1)).toBe(3600000);
});
test("newly admitted work requires fresh consent; rejecting it releases the fence",async()=>{
 let tasks=["old"],fenced=false,confirmations=0;
 const result=await prepareUpdate({snapshot:()=>tasks,confirm:async()=>++confirmations===1,
  fence:()=>{fenced=true;return ()=>{fenced=false;};},settle:async()=>{tasks=["old","arrived while dialog open"];}});
 expect(result).toBeUndefined();expect(confirmations).toBe(2);expect(fenced).toBe(false);
});
test("admission failures release the fence without canceling tasks",async()=>{
 let fenced=false;
 await expect(prepareUpdate({snapshot:()=>[],confirm:async()=>true,fence:()=>{fenced=true;return ()=>{fenced=false;};},settle:async()=>{throw new Error("persistence timeout");}})).rejects.toThrow("persistence timeout");
 expect(fenced).toBe(false);
});
test("diagnostics redact signed URLs and mark truncation",()=>{
 const message=updateDiagnostic(new Error("https://private/file?signature=secret "+"x".repeat(2100)));
 expect(message).not.toContain("signature");expect(message).toContain("[URL redacted]");expect(message).toEndWith(" [truncated]");
});
