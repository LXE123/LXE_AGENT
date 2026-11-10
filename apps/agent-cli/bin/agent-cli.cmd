@echo off
if not defined LXE_MCP_CLI_BUN set "LXE_MCP_CLI_BUN=bun"
"%LXE_MCP_CLI_BUN%" "%~dp0..\src\main.ts" %*
