# Main production parity fixtures

Frozen from `main` on 2026-07-13. These values describe externally relevant behavior, but tests must feed them into the real Bun/TypeScript implementation; a fixture must never be tested only against itself.

- `runtime`: Agent loop defaults, trusted-event compatibility, and user `System:` prefix sanitization.
- `mcp`: configured timeout and exposure defaults consumed by `loadMcpConfig()`.
- `coding`: workspace protection, platform shell, timeout, and process defaults exercised by the native coding-tool and shell-adapter tests.
- `storage`: transcript image redaction exercised by the SQLite Runtime store tests.
- `main-wire-trace-parity.json`: main-compatible request/response/thinking/tool-use/terminal sequence consumed by the real TS WireTrace writer, including the `step_0_attempt_1.jsonl` layout.

Rich post, merged-forward, interactive-card, quote, Bun.Image, maintenance, shutdown, and MCP result fixtures live beside their real implementation tests because they require executable byte streams or injected service ports.
