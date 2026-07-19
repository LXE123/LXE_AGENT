# Agent Host Composition Boundary

Status: Accepted on 2026-07-18

## Decision

The private `agent-cli` process owns its product composition root. Its local `AgentRuntimeHost` assembles the Agent store, provider, Runtime, MCP, Python CLI, Workspace instances, native tools, and DashboardService.

Gateway remains an Electron Main library for channel ingress/egress, permission, routing, scheduling, emitter, process-runtime, route state, and lifecycle. It does not import the concrete Runtime package. Desktop uses Core for the shared machine identity and does not import Runtime either.

The enforced dependency boundaries are:

```text
Desktop -> Gateway -> desktop-protocol / core / protocol
agent-cli -> Runtime -> core / protocol
agent-cli -> desktop-protocol / core / protocol
```

`agent-cli -> gateway`, `gateway -> runtime`, and `desktop -> runtime` are forbidden by manifest, source-import, and bundle-metafile checks.

## Consequences

- Gateway no longer has `dashboard/`, Agent service, native Feishu Agent tools, or a concrete image processor fallback.
- Feishu channel composition must inject `InboundImageProcessorPort`; Desktop supplies the Electron implementation.
- Machine identity has one implementation in `@lxe/core/machine-identity`; its path and JSON format are unchanged.
- Gateway policy still decides allowed skill types. `AgentRuntimeHost` turns that authorization into Workspace/ToolRegistry scope and the `LXESKILL_SKILL_SCOPE` passed to Python CLI commands.
- This ownership migration left NDJSON at v2; the later strict steering handoff change advanced it to v3, and truthful inbound diagnostics subsequently advanced it to v4. Typed Dashboard RPC, SQLite ownership, and product behavior remain unchanged.
