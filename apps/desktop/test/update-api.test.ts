import {expect,test} from "bun:test";
import type {DesktopCloudState,DesktopUpdateRelease} from "@lxe/desktop-protocol";
import {DesktopUpdateApi,UpdateConnectionMonitor,updateConnectionReady} from "../src/main/updates/update-api";
import {companyServerUrl} from "../src/main/cloud/company-server";

function fixture(managed=false) {
 const config={managed,switch_in_progress:false,data_server_url:managed?"http://10.88.0.1:8000/":""};
 const state:Pick<DesktopCloudState,"device_context"|"native_access">={
  device_context:{server_url:companyServerUrl(config),device:null,pending_device:null,skill_types:[],server_capabilities:null,erp_actions:null},
  native_access:{status:"connected",model_status:"unavailable",last_error:"",verified_at:1,is_admin:false},
 };
 const requests:{url:URL;init:RequestInit}[]=[];
 let response=()=>Response.json({state:"up_to_date"});
 const api=new DesktopUpdateApi(()=>state,"0.3.1","installed",async(url,init)=>{requests.push({url,init});return response();});
 return {api,state,requests,config,respond:(fn:()=>Response)=>{response=fn;}};
}

test.each([false,true])("update discovery uses the company address with legacy enrollment=%s",async managed=>{
 const f=fixture(managed);
 expect(updateConnectionReady(f.state)).toBe(true);
 expect((await f.api.latest()).state).toBe("up_to_date");
 expect(f.requests).toHaveLength(1);
 const {url,init}=f.requests[0]!;
 expect(url.href).toBe("http://10.88.0.1:8000/api/v1/desktop-updates/latest?platform=windows-x64&current_version=0.3.1");
 expect(init.method).toBe("GET");expect(init.redirect).toBe("error");
 expect(init.headers).toEqual({"X-LXE-Client":"cli"});
});

test("offline manual checks preserve the actual network error and recovery enables automatic checks",async()=>{
 const f=fixture();f.state.native_access!.status="offline";
 expect(updateConnectionReady(f.state)).toBe(false);
 f.respond(()=>{throw new Error("connect ECONNREFUSED 10.88.0.1:8000");});
 await expect(f.api.latest()).rejects.toThrow("connect ECONNREFUSED 10.88.0.1:8000");
 f.state.native_access!.status="connected";f.respond(()=>Response.json({state:"up_to_date"}));
 expect(updateConnectionReady(f.state)).toBe(true);
 expect((await f.api.latest()).state).toBe("up_to_date");
});

test("routine cloud probes do not wake updates, but actual network recovery wakes once",()=>{
 const f=fixture(),monitor=new UpdateConnectionMonitor();
 expect(monitor.restored(f.state)).toBe(true);
 for(const status of ["pending","checking","connected","connected"] as const) {
  f.state.native_access!.status=status;
  expect(monitor.restored(f.state)).toBe(false);
 }
 for(const failure of ["offline","denied","error"] as const) {
  f.state.native_access!.status=failure;expect(monitor.restored(f.state)).toBe(false);
  f.state.native_access!.status="checking";expect(monitor.restored(f.state)).toBe(false);
  f.state.native_access!.status="connected";expect(monitor.restored(f.state)).toBe(true);
  expect(monitor.restored(f.state)).toBe(false);
 }
 f.state.device_context!.server_url="";expect(monitor.restored(f.state)).toBe(false);
 f.state.device_context!.server_url=companyServerUrl(f.config);expect(monitor.restored(f.state)).toBe(true);
});

test("missing address and pending device identity block requests before transport",async()=>{
 const f=fixture();
 f.state.device_context!.pending_device={server_url:"http://10.88.0.1:8000",id:"new",kind:"managed_device",display_name:"New",wireguard_ip:"10.88.0.2"};
 expect(updateConnectionReady(f.state)).toBe(false);
 await expect(f.api.latest()).rejects.toThrow("设备身份已变化");
 f.config.switch_in_progress=true;
 f.state.device_context!.pending_device=null;
 f.state.device_context!.server_url=companyServerUrl(f.config);
 expect(updateConnectionReady(f.state)).toBe(false);
 await expect(f.api.latest()).rejects.toThrow("更新服务地址为空");
 expect(f.requests).toHaveLength(0);
});

test.each(["https://10.88.0.1:8000","http://example.com:8000","http://user:secret@10.88.0.1:8000"])("company origin restriction remains enforced: %s",async server=>{
 const f=fixture();f.state.device_context!.server_url=server;
 await expect(f.api.latest()).rejects.toThrow("更新服务地址必须是已配置的公司 WireGuard 服务");
 expect(f.requests).toHaveLength(0);
});

test("revoked authorization preserves server diagnostics while paused publication remains paused",async()=>{
 const f=fixture();f.state.native_access!.status="denied";
 expect(updateConnectionReady(f.state)).toBe(false);
 f.respond(()=>Response.json({detail:{code:"device_disabled",message:"Device access revoked"}},{status:403}));
 await expect(f.api.latest()).rejects.toThrow('HTTP 403 {"code":"device_disabled","message":"Device access revoked"}');
 f.respond(()=>Response.json({state:"paused"}));
 expect(await f.api.latest()).toEqual({state:"paused",release:null});
});

test("download tickets resolve the latest company state and retain build binding",async()=>{
 const f=fixture();
 const release:DesktopUpdateRelease={version:"0.3.2",build_id:"next",file_name:"LXE-Agent-0.3.2-windows-x64.exe",size:3,
  sha512:Buffer.alloc(64).toString("base64"),notes:"test",blockmap:{file_name:"LXE-Agent-0.3.2-windows-x64.exe.blockmap",size:3,sha512:Buffer.alloc(64).toString("base64")}};
 const url="https://lxe-agent-updates-1317107914.cos.ap-guangzhou.myqcloud.com/artifacts/0.3.2/next/"+release.file_name+"?signature=test";
 f.respond(()=>Response.json({url,expires_at:Math.floor(Date.now()/1000)+600}));
 expect((await f.api.ticket(release)).url).toBe(url);
 expect(f.requests[0]!.url.pathname).toBe("/api/v1/desktop-updates/download");
 expect(JSON.parse(f.requests[0]!.init.body as string)).toEqual({version:"0.3.2",build_id:"next",platform:"windows-x64",include_blockmaps:true,base_release:{version:"0.3.1",build_id:"installed"}});
 f.state.device_context!.server_url="";
 await expect(f.api.ticket(release)).rejects.toThrow("更新服务地址为空");
 expect(f.requests).toHaveLength(1);
});
