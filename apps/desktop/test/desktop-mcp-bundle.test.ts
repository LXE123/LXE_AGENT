import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDesktopPipe } from "../src/mcp/pipe";
import { takeDesktopMcpConfig } from "../../agent-cli/src/desktop-mcp";
import { OfficialMcpConnector } from "../../../packages/agent/runtime/src/tooling/mcp";

const node = process.env.LXE_OFFICE_NODE || Bun.which("node");
test.skipIf(!node)("packaged standalone MCP bundle runs under Node without workspace dependencies", async()=>{
  const root=mkdtempSync(join(tmpdir(),"lxe-mcp-bundle-")), script=join(root,"desktop-mcp.mjs");
  const build=await Bun.build({entrypoints:[join(import.meta.dir,"../src/mcp/server.ts")],outdir:root,naming:"desktop-mcp.mjs",target:"node",format:"esm"});
  expect(build.success).toBe(true);
  const pipe=await startDesktopPipe({token:"fixture",call:async(method,params)=> method==="tools/list" ? {} : {echo:params}});
  const config=takeDesktopMcpConfig({LXE_DESKTOP_MCP_COMMAND:node!,LXE_DESKTOP_MCP_SCRIPT:script,LXE_DESKTOP_MCP_PIPE:pipe.path,LXE_DESKTOP_MCP_TOKEN:"fixture"})!;
  config.cwd=root;
  let connection;
  try {
    connection=await new OfficialMcpConnector().connect(config);
    expect(connection.protocolVersion).toBe("2026-07-28");expect(connection.tools).toHaveLength(4);
    const result=await connection.callTool("automation_list",{});
    expect(result.isError).toBe(false);expect(JSON.stringify(result.content)).toContain("automation_list");
  }finally{await connection?.close();await pipe.close();rmSync(root,{recursive:true,force:true});}
},15_000);
