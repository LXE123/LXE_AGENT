# Manage user MCP servers

## Check status

Run `agent-cli mcp list` to connect to every enabled user-configured server and
print its state, tools, errors and sign-in command. It exits with status 1 if an
enabled server fails to connect. Use `list --json` for a JSON array.

Each run creates temporary connections and closes them afterward, whether run
through `exec` or in a terminal. This checks connectivity without replacing a
chat's connections. Desktop-injected services such as `lxe_desktop` are not part
of this check.

## Sign in and out

For a server marked `needs_auth`, run its sign-in command when the user requests
login, for example:

```sh
agent-cli mcp login team-skills
```

Use the configured server name, including hyphens, rather than its tool namespace
(`mcp__team_skills`). `login` checks the connection using saved credentials when
available. If browser authorization is needed, it prints the authorization URL
and attempts to open it; the user can open the URL manually. If the command is
still running, use `wait` with its `exec_id` to collect the final result.

Report progress from the command's output. A successful final result means the
connection was verified and its tools are available. If credentials were saved
but reconnection failed, report both facts and retry the same login command to
use those credentials. Preserve the actual returned error: a network failure
alone does not establish that sign-in is needed. Fixed API keys or Authorization
headers may need updating in the configuration instead.

`agent-cli mcp logout <name>` deletes locally saved OAuth credentials while
keeping the server configuration. It does not revoke provider access, end the
browser's login session or remove fixed HTTP headers.

## Add and remove servers

Add or replace a user configuration:

```sh
agent-cli mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
agent-cli mcp add files --cwd /path/to/workspace -- node /path/to/mcp-server.js
```

`add` saves the definition without starting it. `agent-cli mcp remove <name>`
removes the definition but keeps saved OAuth credentials. The desktop also
provides **Capabilities → MCP services → Add service**. Run
`agent-cli mcp --help` or a subcommand with `--help` for options.

## Configuration scope

Configuration and OAuth credentials are shared by all workspaces using the same
LXE data root (`LXE_DATA_ROOT`); connections belong to individual chats. Use the
same data root in an independent terminal to manage the same servers and credentials.
Configuration changes apply before each chat's next model call and on the next
standalone command. A chat awaiting sign-in also checks for updated credentials
before its next model call.
