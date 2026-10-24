import { expect, test } from "bun:test";
import { takeDesktopMcpConfig } from "../src/desktop-mcp";

test("managed desktop credentials are removed before creating exec and external MCP environments",()=>{
  const env: Record<string,string|undefined>={LXE_DESKTOP_MCP_COMMAND:"node",LXE_DESKTOP_MCP_SCRIPT:"server.mjs",LXE_DESKTOP_MCP_PIPE:"pipe",LXE_DESKTOP_MCP_TOKEN:"private",LXE_DESKTOP_MCP_ENABLED:"0",OTHER:"keep"};
  const config=takeDesktopMcpConfig(env)!;
  expect(env).toEqual({OTHER:"keep"}); expect(config.enabled).toBe(false); expect(config.platforms).toEqual(["desktop"]);
  expect(config.env).toEqual({LXE_DESKTOP_MCP_PIPE:"pipe",LXE_DESKTOP_MCP_TOKEN:"private"});
  expect(takeDesktopMcpConfig({})).toBeUndefined();
  const partial: Record<string,string|undefined>={LXE_DESKTOP_MCP_TOKEN:"secret"}; expect(()=>takeDesktopMcpConfig(partial)).toThrow("Incomplete"); expect(partial).toEqual({});
});
