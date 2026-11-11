# Manage user MCP servers

In a local chat, use `exec` to run `agent-cli mcp list`. It reports the live
connections used by this chat. Other chats own separate connections. A chat
reuses its connections across turns; after 30 idle minutes they are released
and rebuilt on the next use. Configuration and OAuth credentials remain shared.

For a server marked `needs_auth`, the output includes its sign-in command.
When the user asks to sign in, run that command with `exec`, for example
`agent-cli mcp login team-skills`. Use the configured name from the list,
including hyphens; `mcp__team_skills` is the tool namespace, not the server name.

`login` first checks the connection. It uses saved credentials when available
and opens the authorization page only if the server requires sign-in. The initial
"Checking connection" output does not mean a browser has opened.
If `exec` reports `status: running`, use `wait` with its `exec_id` to collect the
outcome. Both running and finished commands have an `exec_id`; check the status
and exit code. A finished command with a nonzero exit code has failed and is no
longer waiting for browser approval. Do not launch a second login while one runs.
A successful command means the Harness has verified the connection; its tools
are then available for discovery. It may have reused credentials without a new
browser login. An already connected server needs no login.
If OAuth credentials were saved but the connection failed, report both facts.
Retry the same login command to reconnect using the saved credentials. The
Harness asks for browser sign-in again only if the server challenges them.
Failures identify the server and phase: connection, sign-in, credential saving,
or reconnection after credentials were saved. Report the actual returned error;
a network failure alone does not establish that the user needs to sign in.
A server configured with a fixed
API key or Authorization header may need its configured credentials updated instead.

From a terminal without an active chat, the same commands work independently.
Use the same LXE data root (`LXE_DATA_ROOT`) as the chat to share credentials.
Standalone `list` opens temporary connections to each enabled user server, discovers
its tools and closes the connections before exiting. Desktop-injected services
such as `lxe_desktop` are only present in the desktop host. Both forms print the
connection state, tool names and any error; `list --json` returns a JSON array.
Exit status 1 means an enabled server is not ready or the configuration is invalid.
Standalone `login` connects only the requested service. A running Harness picks
up the new credentials for a service awaiting sign-in before its next model call.

Use `agent-cli mcp logout <name>` to forget that server’s locally stored OAuth
credentials without removing the server. To sign in again, run `login <name>`.
Logging out does not revoke access at the provider or remove fixed HTTP headers.

From a terminal, add or replace a user configuration with either form:

```sh
agent-cli mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
agent-cli mcp add files --cwd /path/to/workspace -- node /path/to/mcp-server.js
agent-cli mcp remove files
```

`add` saves the definition without starting it; `remove` keeps saved OAuth
credentials. Config edits apply before each chat’s next model call and on the
next standalone command. You can also add services through
**Capabilities → MCP services → Add service**; viewing or saving settings does
not probe connections. All workspaces using the same
LXE data root share the configuration. Run `agent-cli mcp --help` for options.
