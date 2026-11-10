# MCP server status and browser sign-in

In a desktop chat, use `exec` to run `agent-cli mcp list`. It reports the live
connections used by this chat without starting another Agent or reconnecting servers.

For a server marked `needs_auth`, the output includes its sign-in command.
When the user asks to sign in, run that command with `exec`, for example
`agent-cli mcp login team-skills`. Use the configured name from the list,
including hyphens; `mcp__team_skills` is the tool namespace, not the server name.

The desktop app opens the authorization page; the user approves in their browser.
If `exec` returns an `exec_id`, tell the user to finish in their browser and
use `wait` with that ID to collect the outcome. Do not launch a second login.
A successful command means the desktop has verified the connection; its tools
are then available for discovery. An already connected server needs no login.
If sign-in fails, report the returned error. A server configured with a fixed
API key or Authorization header may need its configured credentials updated instead.
