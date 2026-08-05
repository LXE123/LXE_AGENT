# Unified Settings Store

Status: `Accepted`

Model credential storage and dotenv import in this record were superseded by
[`20260805-cloud-default-local-auth.md`](20260805-cloud-default-local-auth.md).

## Decision

LXE Agent now owns one non-sensitive runtime settings file at `var/config/settings.json`. Desktop credentials remain encrypted in `var/config/secrets.bin`; source development may use a Git-ignored `.env` containing only secrets. Product defaults live in code rather than a tracked `runtime.env` file.

Desktop Main is the only settings writer. Agent and Python processes receive one resolved in-memory environment and do not search the repository for dotenv layers. Dashboard model and thinking mutations are applied in the Agent process first, then persisted by Desktop after the typed RPC succeeds.

## Migration

The schema-v4 repository reads `settings.json` first. When only legacy `desktop.json` exists, it validates and converts the old structure, atomically writes `settings.json`, and renames the original to a migration backup. Legacy `.env.local` values are accepted only by the one-time migration/import path and no longer participate in runtime precedence. The source-root `.env` is different: source Desktop reads its allowlisted secrets on every launch as an in-memory override and never migrates them into `secrets.bin`; packaged Desktop ignores it completely.

Settings writes use a sidecar lock, temporary file, atomic rename, and content fingerprint. Invalid JSON, secret-shaped fields, unsupported schema versions, concurrent writers, and unacknowledged external edits fail closed instead of being silently replaced.

## Consequences

- `config/runtime.env`, `.env.local.example`, `runtime_env_path`, and `LXE_RUNTIME_ENV_PATH` are retired.
- Python `lxeskill` is a stateless executor and reads only its inherited process environment.
- Permission policy, provider catalogs, and MCP defaults remain Git-tracked product contracts; they are not user settings.
- Secret-vault `.env` profiles remain portable one-time Desktop import inputs and are not runtime configuration.
