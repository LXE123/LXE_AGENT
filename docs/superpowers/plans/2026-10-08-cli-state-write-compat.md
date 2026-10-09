# CLI state write compatibility — approved implementation plan

Original reviewed source: `codex/cli-state-write-compat`, pool-17; final repair: `codex/pr1-cli-state-compat`, pool-19; base: `upstream/main` / `5f785341`. The approved migration-boundary correction is inherited unchanged by pool-20/21/22.

## Scope

Repair CLI bootstrap writes denied by workspace-write. The trusted host may grant a standalone catalog `visibility=business` invocation only three fixed Python directories: `lxeskill/`, `db/lxeskill/`, `logs/` under its data root. Ordinary commands, read-only mode, Bun DB, configuration and exec-session state retain their existing restrictions. No additional managed root under the already writable temporary directory.

No platform conditions, Skill/Contract/Workflow/schema/authentication changes, Runtime Step Loop changes or production API tests. Git staging/commits/pushes were prohibited in acceptance; separately authorized delivery on 2026-10-09 permits only the controlled four-layer commits/parent chain and normal local-origin sync. Original business branches remain untouched; service transitions require separate explicit authorization. This public repair is an independent review unit, not an uncommitted overlay on the three business branches.

## Tasks and verification

1. Add and run failing regressions for exact catalog classification, separate sandbox capability, Desktop temp overlap, symlink escape and Python DB migration.
2. Reuse the necessary existing boundary implementation; macOS per-child Seatbelt roots and Windows separate restricted-token SID. Align native Windows roots with the same three directories and preserve read-only construction. Verify standalone shell composition cannot receive the grant.
3. Move only Python DB paths beneath `db/lxeskill/`; On first access to the requested default Python DB, migrate only the three confirmed Python tables in a read transaction (including committed WAL), validate and atomically publish without overwrite; preserve legacy files. Never copy Bun/unknown tables, open agent.sqlite3 or scan unrelated legacy files for custom paths / ordinary CLI commands. Update existing injection/relocation readers and relevant documentation.
4. Exercise the actual CLI through exec/sandbox without production APIs, plus migration, sandbox, Desktop and four-platform fixture regressions. Run workspace typecheck, diff checks and Git status; confirm business branches unchanged.
5. Write handoff with evidence, limitations and next step. Windows-native ACL execution is NOT VERIFIED on this macOS host. Current active service and exact source status are recorded in the module handoff; native Windows remains unverified.

Files: runtime permissions/exec adapter and native Windows sandbox; existing Desktop/agent-cli Python DB injection points; Python SQLite bootstrap/migration and relocation helpers; their focused tests; permission and DB docs.

## Subsequently approved isolated service verification (historical pool-18 stage)

On 2026-10-08 the user approved connecting the reviewed repair and starting the Shangman test service. Create an explicit pool worktree on the existing Shangman routing commit, apply only the reviewed generic repair, retain the three original business branches, and rerun targeted fixture/sandbox tests, typecheck, build and diff checks. Reuse only local configuration and paired identity without old sessions or pending jobs. Stop only the previously identified Shangman service, start the new worktree on port 5174, verify actual source cwd and gateway readiness, and leave live export validation to the user. No staging, commit, push, security relaxation or new business behavior is authorized.

This historical stage was completed and later superseded by the separately approved pool-22 complete service. It is not an instruction to restart pool-18; current service and acceptance status are in the consolidated handoff.
