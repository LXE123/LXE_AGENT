/** Live-model, fixed-terminal skill replay. Tools never execute shell commands or send files.
 * Credentials arrive on stdin as { env, managedLlmState }; only action traces are written.
 * Run from the repository root: bun scripts/verify-replenishment-skill-behavior.ts <output.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { loadProviderDescriptor } from "../packages/agent/runtime/src/providers/provider";
import { createRuntimeProvider } from "../packages/agent/runtime/src/providers/provider-factory";
import type { RuntimeMessage, ToolSchema } from "../packages/agent/runtime/src/engine/types";

const root = process.cwd();
const input = JSON.parse(await Bun.stdin.text());
const descriptor = loadProviderDescriptor(root, input.env ?? process.env, { managedLlmState: input.managedLlmState });
const provider = createRuntimeProvider(descriptor);
const system = `你是备货助手。按实际用户范围使用技能并完成交付。本测试的 exec、send_files 都是隔离工具，只返回固定结果，不访问业务服务或用户文件。不要猜工具结果。\n已读取完整流程入口：\n${readFileSync(resolve(root, "skills/replenishment-workflow-map/SKILL.md"), "utf8")}\n其他技能位于 skills/replenishment-*/SKILL.md，请按需 read。`;
const tools: ToolSchema[] = [
  { name: "read", description: "读取技能文档", input_schema: {type:"object",properties:{path:{type:"string"}},required:["path"]} },
  { name: "exec", description: "执行 CLI，返回实际 terminal 或运行状态", input_schema: {type:"object",properties:{command:{type:"string"}},required:["command"]} },
  { name: "send_files", description: "将文件交付用户", input_schema: {type:"object",properties:{paths:{type:"array",items:{type:"string"}}},required:["paths"]} },
  { name: "ask_user", description: "请求用户选择候选或提供必要输入", input_schema: {type:"object",properties:{question:{type:"string"}},required:["question"]} },
];
const names = ["store resolve", "msku download", "sales analyze", "inventory actual-export", "shipments unlinked-download", "calculate"];
const sourceTime = "202609080101", snapshot = "C:/fixture/202609080102-Amazon-Test-US_未关联货件快照.xlsx";
const source = "C:/fixture/202609080101-Amazon-Test-US_店铺MSKU数据.xlsx";
const report = "C:/fixture/202609080101-Amazon-Test-US_备货建议.xlsx";
const data: Record<string, any> = {
  "store resolve": {store_name:"Amazon-Test-US",store_id:"100",id_type:"shopId"},
  "msku download": {xlsx_path:source,source_data_time:sourceTime,original_row_count:12,active_row_count:10,excluded_row_count:2},
  "sales analyze": {report_xlsx_path:"C:/fixture/sales.xlsx",source_xlsx_path:source,source_data_time:sourceTime,msku_count:10,link_count:3},
  "inventory actual-export": {shenzhen_warehouse_inventory_report_xlsx_path:"C:/fixture/inventory.xlsx",source_msku_xlsx_path:source,source_msku_data_time:sourceTime},
  "shipments unlinked-download": {status_results:["WMS待配货","WMS待装箱","待关联货件"].map(status_name=>({status_name,total:0})),snapshot:{snapshot_xlsx_path:snapshot,confirmed_empty:true,total_unlinked_quantity:0}},
  calculate: {report_xlsx_path:report,source_data_time:sourceTime,template_name:"默认",template_version:1,original_row_count:12,active_row_count:10,excluded_row_count:2,row_count:10,link_count:3,air_urgent_count:2,air_count:2,sea_count:1,no_ship_count:5,unlinked_shipments_snapshot_path:snapshot},
};
const full = "请帮 Amazon-Test-US 完成一次备货并把最终文件发给我。";
const singleCalc = `只用已有同源销量、库存报告和这个同日快照重算并交付：店铺 Amazon-Test-US，快照 ${snapshot}。`;
const cases = [
  {id:"full_zero", prompt:full},
  {id:"single_sales", prompt:"只生成 Amazon-Test-US 的销量分析，已有核验源表，不需要备货计算。"},
  {id:"ambiguous", prompt:full.replace("Amazon-Test-US","Test")},
  {id:"auth_true", prompt:"只下载 Amazon-Test-US 的 MSKU，已解析 store_id=100、id_type=shopId。"},
  {id:"auth_false", prompt:"只下载 Amazon-Test-US 的 MSKU，已解析 store_id=100、id_type=shopId。"},
  {id:"locked", prompt:singleCalc},
  {id:"send_retry", prompt:singleCalc},
  {id:"shipments_failed", prompt:full},
];
const results: any[] = [];
let lastTrace: any[] = [];
const output = resolve(process.argv[2] ?? "var/validation/replenishment-skill-behavior.json");
mkdirSync(dirname(output),{recursive:true});
const save = () => writeFileSync(output,JSON.stringify({provider:descriptor.name,model:descriptor.model,results},null,2));
const assert = (test:unknown,message:string) => {if(!test)throw new Error(message);};
async function run(scenario: typeof cases[number]) {
  const trace:any[]=[]; lastTrace=trace; const messages:RuntimeMessage[]=[{role:"user",content:scenario.prompt}];
  const calls:string[]=[]; let sends=0, reply="";
  for(let step=0;step<26;step++) {
    const message=await provider.turn({system,messages,tools,toolChoice:"auto",signal:AbortSignal.timeout(180000)});
    messages.push(message);
    const toolCalls=message.content.filter(c=>c.type==="tool_call");
    reply=message.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
    if(!toolCalls.length)break;
    for(const call of toolCalls) {
      const args=call.arguments??{};let value:any;
      if(call.name==="read") {
        const path=resolve(root,String(args.path));const rel=relative(resolve(root,"skills"),path);
        assert(!rel.startsWith("..") && rel.startsWith("replenishment-"),"read escaped fixture skills");
        value=readFileSync(path,"utf8");
      } else if(call.name==="exec") {
        const command=String(args.command);const action=command.includes("lxeskill auth refresh")?"auth refresh":names.find(n=>command.includes(`lxeskill replenish ${n}`));
        assert(action,"unexpected command: "+command);calls.push(action!);
        const fail=(message:string,refresh=false,extra:any={})=>({type:"result",ok:false,data:{auth_refresh_required:refresh,...extra},files:[],error:{code:"business_cli_failed",message}});
        const count=calls.filter(c=>c===action).length;
        if(scenario.id==="ambiguous"&&action==="store resolve")value=fail("店铺名不唯一",false,{candidates:[{store_name:"Amazon-Test-US",store_id:"100",id_type:"shopId"},{store_name:"Amazon-Test-UK",store_id:"101",id_type:"shopId"}]});
        else if(scenario.id==="auth_true"&&action==="msku download"&&count===1)value={...fail("网页登录过期",true),recovery:{command:"lxeskill auth refresh"}};
        else if(scenario.id==="auth_false"&&action==="msku download")value=fail("官方店铺 401403 查询失败：mabang_access_denied",false);
        else if(scenario.id==="locked"&&action==="calculate")value=fail("[WinError 5] 拒绝访问：最终文件被占用",false);
        else if(scenario.id==="shipments_failed"&&action==="shipments unlinked-download")value=fail("查询 WMS待装箱 timeout；本轮查询未完成",false);
        else {
          const payload={success:true,store_name:"Amazon-Test-US",...(data[action!]??{})};
          const path=payload.report_xlsx_path??payload.xlsx_path??payload.shenzhen_warehouse_inventory_report_xlsx_path??payload.snapshot?.snapshot_xlsx_path;
          value={type:"result",ok:true,data:payload,files:path?[path]:[]};
        }
      } else if(call.name==="send_files") {sends++;value={success:scenario.id!=="send_retry"||sends>1};}
      else if(call.name==="ask_user") value={status:"awaiting_user"};
      else throw new Error("unexpected tool: "+call.name);
      trace.push({tool:call.name,args,...(call.name==="read"?{}:{result:value})});
      messages.push({role:"user",content:[{type:"tool_result",tool_call_id:call.id,content:typeof value==="string"?value:JSON.stringify(value)}]});
    }
    if(trace.at(-1)?.tool==="ask_user")break;
  }
  const business=calls.filter(c=>c!=="auth refresh");
  if(scenario.id==="full_zero") {assert(JSON.stringify(business)===JSON.stringify(names),"full workflow order/repeated zero query");assert(sends===1,"must only send final report");assert(trace.some(t=>t.tool==="exec"&&t.args.command.includes("calculate")&&t.args.command.includes(snapshot)&&t.args.command.includes("--unlinked-shipments-snapshot")),"did not bind current snapshot");}
  if(scenario.id==="single_sales")assert(JSON.stringify(business)==='["sales analyze"]'&&sends===1,"single request expanded");
  if(scenario.id==="ambiguous")assert(business.every(c=>c==="store resolve")&&business.length===1&&sends===0,"proceeded after ambiguity");
  if(scenario.id==="auth_true")assert(JSON.stringify(calls)==='["msku download","auth refresh","msku download"]',"wrong auth recovery");
  if(scenario.id==="auth_false")assert(JSON.stringify(calls)==='["msku download"]'&&sends===0,"guessed auth from numeric ID");
  if(scenario.id==="locked")assert(JSON.stringify(calls)==='["calculate"]'&&sends===0,"retried locked target without user action");
  if(scenario.id==="send_retry")assert(JSON.stringify(calls)==='["calculate"]'&&sends===2,"recalculated on delivery failure");
  if(scenario.id==="shipments_failed")assert(JSON.stringify(business)===JSON.stringify(names.slice(0,5))&&sends===0,"continued after shipment failure");
  return {id:scenario.id,passed:true,calls,sends,reply,trace};
}
for(const scenario of cases) {
  try {results.push(await run(scenario));console.log(JSON.stringify({case:scenario.id,passed:true}));}
  catch(error){results.push({id:scenario.id,passed:false,error:(error instanceof Error?error.message:String(error)).replaceAll(descriptor.apiKey,"[REDACTED]"),trace:lastTrace});console.log(JSON.stringify({case:scenario.id,passed:false}));}
  save();
}
if(results.some(r=>!r.passed))process.exitCode=1;
