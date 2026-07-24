# Internalize Stable Runtime Constants

Date: 2026-07-24

## Decision

Stable product behavior no longer consumes environment variables for log formatting and file names, Feishu WebSocket restart timing, Ziniao's control port, browser-auth locking, WMS retry count, maintenance timing, Data Server request timing, Provider output/idle limits, or stream heartbeat timing.

Diagnostic directories are derived from `LXE_DATA_ROOT` under `logs/` instead of accepting independent path overrides.

## Why

These values were not meaningful user preferences. Keeping them in `config/runtime.env` expanded the configuration surface and made Desktop, Gateway, Runtime, and Python processes easier to configure inconsistently. Product-owned constants now give every process the same behavior without environment propagation.

## Still Configurable

Operators can still choose whether local logs and diagnostics are enabled, set log levels and retention, select the LLM provider/model/thinking effort, and configure machine-specific executable or data paths. Secrets and private identities remain outside Git-managed runtime defaults.
