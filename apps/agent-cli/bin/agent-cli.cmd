@echo off
if not defined LXE_AGENT_CLI_BUN set "LXE_AGENT_CLI_BUN=bun"
"%LXE_AGENT_CLI_BUN%" "%~dp0..\src\main.ts" %*
