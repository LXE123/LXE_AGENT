# Cloud-default and local BYOK authentication

Status: `Accepted`

## Decision

New and upgraded Desktop installations use the company-managed DeepSeek model by default. The company credential continues to arrive through the authenticated cloud control plane and remains encrypted in `var/config/secrets.bin`. A valid cached credential supports offline startup; an explicit server response of `managed_llm.available: false` revokes it, while a network failure does not.

Users may optionally save their own Kimi Coding, DeepSeek, or GLM key from Desktop Settings. These local credentials are plaintext JSON in `var/config/auth.json`:

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

There is no application-layer encryption for this file. On POSIX, Desktop creates `var/config` with mode `0700` and writes `auth.json` and its sidecar lock with mode `0600`. Windows uses the per-user application data directory and inherited NTFS ACLs; POSIX mode bits are not presented as a Windows security guarantee. Writes use an exclusive lock, temporary file, and atomic rename. Invalid JSON is reported and never silently overwritten.

Saving a local key does not replace a valid active company credential. Without a valid company credential it activates the saved local provider so setup can finish. Deleting an active local key falls back to the company credential, then another configured local provider; otherwise setup becomes incomplete and the Agent stops.

## Migration

Before Gateway startup, migration version 4 selects `deepseek` / `deepseek-v4-flash` with credential source `cloud`, removes legacy model keys from encrypted `provider_keys`, and deletes application-data `.env` and `.env.local`. Old model keys are deliberately not copied to `auth.json`.

The `.env` import UI, preload/IPC contract, preview drafts, and application logic are removed. Model key variables are also removed from the source-development secret allowlist and `.env.example`. The source-root `.env` remains a development-only override for allowlisted non-model integration secrets; packaged Desktop never reads it.

## Consequences

- The company raw model key still reaches activated clients; this design does not provide server-side request proxying.
- Anyone who can read the user's application data can read local BYOK credentials.
- The settings API exposes only configured booleans, the auth file path, and read errors; it never returns key values to the Renderer.
- An invalid cached credential can be fetched again even when the server revision is unchanged, allowing recovery after a model-provider `401`.
