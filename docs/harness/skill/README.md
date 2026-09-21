# Skill Documentation

Runtime skill prompts live in repository `skills/*/SKILL.md`, managed user skills under `<dataRoot>/skills` (normally `var/skills`), and shared skills under `~/.agents/skills`. This directory explains discovery and classification; it does not duplicate full runtime prompts.

## Discovery And Precedence

`packages/agent/runtime/src/tooling/skills.ts` scans all three sources and deduplicates canonical paths. Name precedence is repository → managed user → shared. Conflicts resolve before enabled-state, device-permission and connector filtering: disabling a winner never exposes its same-name fallback. Invalid, duplicate or command-conflicting external entries have per-entry diagnostics; invalid official resources still fail strictly.

`LXE_USER_SKILLS_ROOT` overrides the managed user directory consistently in Desktop and standalone CLI. Shared files are never migrated or rewritten automatically. The resolved managed path is published as `environment_context.user_skills_root`, so creators do not guess installation paths. Files saved elsewhere are not discovered automatically.

Bun stores disabled entry paths in `<dataRoot>/config/skill-states.local.json`; the Markdown files remain the only body source. Editing preserves state. Both files and configuration live in the application data directory retained during upgrades. There are no Python skill tables or model management tools.

Desktop packaging keeps repository skills in the read-only resource root while the user's workspace is writable and separate. In that split-root mode the catalog publishes canonical absolute manifest paths; when a repository skill is already inside the workspace it keeps the shorter workspace-relative path. Relative tool paths always remain workspace-relative, so a workspace `skills/` directory cannot shadow a bundled manifest selected by the catalog.

The catalog validates that referenced files:

- use relative paths;
- exist beneath the declared skill root;
- remain beneath the real root after symlink resolution;
- cannot escape through `..` or a linked path.

The catalog signature includes all attached files, not only SKILL.md. Runtime checks for changes in the background and before subsequent turns; `skills.changed` invalidates Dashboard lists and previews.

## Visibility And Activation

Discovery is not the same as model activation.

1. Runtime discovers and validates the catalog.
2. The server-verified device permission snapshot filters skills by allowed type.
3. Connector state can hide optional connector-owned skills.
4. The prompt receives compact metadata for only the available skills.
5. The model reads a skill's `SKILL.md` when it chooses that workflow. Activation matches the canonical manifest path in the current snapshot; an unrelated draft or a same-name folder cannot activate it.
6. Owner-gated deferred tools from the activated skill become available on the next step.

Resolve skill references, scripts and assets from the manifest's actual directory rather than the process working directory. Catalog reference validation prevents references escaping a skill root; it does not sandbox coding tools. File tools and command working directories can access host paths using the Agent process user's OS permissions. See the [runtime tool trust boundary](../runtime/tools/README.md#本机信任模型).

This keeps the base prompt bounded while preserving detailed workflow contracts on demand.

## Creating And Managing User Skills

Ask the Agent to create a skill, modify one, or save a completed workflow. The built-in `skill-creator` uses the existing read/write/edit/exec tools and managed Python environment. It writes supporting files before SKILL.md, runs static validation, and verifies changed scripts with examples separately. New names use lowercase letters, numbers and hyphens, match the folder, and are at most 64 characters; descriptions are required and at most 1024 characters. Existing shared skills use compatibility validation without being renamed.

The capability tabs are Skills → Tools → Connections → Models. A fresh window without a saved selection starts on Skills; valid saved selections and explicit routes are preserved.

Dashboard → Skills combines managed entries with the Default group, including disabled, invalid and shadowed entries. This is display grouping only: manifest types and permission checks are unchanged. The top-right + menu offers Add skill. Cards open details; all entries share a Markdown-first detail layout with a wrapping description. Skill previews reuse conversation Markdown typography, including headings, quotes, code and tables; only their scroll container differs. Source and status badges size to their text rather than stretching across the card. The More menu switches preview/source, copies the currently selected file, and expands skill information (category, technical name, source directory, actual path and business commands). The SKILL.md preview omits only an opening level-one heading, since the dialog already displays the skill name; source view, copy and attached-file headings remain complete. Attached files remain selectable. Managed entries retain Use in conversation and Move to recycle folder. There is no Dashboard enable/disable control; existing disabled states remain respected. Official and shared details retain their existing read-only controls.

Add skill and Use in conversation append a natural-language prompt to a new conversation draft; they do not send messages or run skills. To modify a skill, ask the Agent directly in a conversation. Sending uses the existing `sessions.send` route.

`skills.user.list/content/setEnabled/delete` remain Dashboard RPC operations, not model tools. The UI no longer calls `setEnabled`; its configuration and backend support remain compatible. Mutations use a server-issued path identity and version; stale writes fail and require reloading. Deletion moves the whole folder to `<dataRoot>/trash/skills`, which is excluded from discovery even when a custom root contains it. Across filesystem volumes, it copies the folder and rechecks the source version before removal; if removal fails, the complete recovery copy is retained and its path is reported. Restore by asking the Agent to move it back with file tools. Shared originals can be changed only when explicitly requested in conversation.

## Business Commands

Business skills declare versioned `lxeskill ...` commands from `python/lxeskill_cli/lxeskill/catalog.json`. Catalog protocol version 1 records the command path, schema, handler/module, owner skills, timeout, visibility and artifact declarations.

Runtime skills invoke their owned command through native `exec` as one standalone `lxeskill ...` call. They must not instruct the model to invoke internal Python modules or compose the command with shell operators. Runtime owns process control, while the CLI owns authorization, parameter validation, JSONL output and business dispatch.

## Usage Tracking

Runtime records which skills were activated and used during a turn. This supports diagnostics and Dashboard visibility without copying complete skill text into logs or persisted usage records.

## Documentation Classes

- [Current skill catalog](current_skill_catalog.md): active repository skill inventory and categories.
- [Reference](reference/README.md): external platform or vendor material.

Reference material supports API and policy checks; runtime instructions remain in the active `SKILL.md`. Superseded drafts and workflow recordings are removed; their history remains in Git.

## Maintenance Checklist

When adding or renaming a skill:

1. keep `name`, `type`, description, and allowed tools precise;
2. make all references relative and contained inside the skill root;
3. register each business command in the catalog with explicit ownership and schema;
4. update workflow-map routing when the user intent changes;
5. update catalog/count tests and this inventory if categories change;
6. test device-permission and connector filtering where applicable;
7. avoid copying the full prompt into `docs/`.
