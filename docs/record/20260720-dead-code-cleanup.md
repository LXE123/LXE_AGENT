# Dead code cleanup across gateway, runtime, dashboard, and lxeskill

Status: `Accepted`

An architecture review found that the main modules are sound, but each area had
accumulated retired mechanisms that were still compiled, tested, and maintained.
This cleanup deletes them; no behavior changes beyond the legacy-transcript
handling noted below.

What was removed:

- Gateway: the unused `gatewaySettings` env helper, write-only scheduler start
  APIs, the end-to-end dead Feishu reaction event chain (the typing-indicator
  reaction port stays), the unreachable `hasQueued` restart deferral, the
  protocol package's unused inbound-event contract validators and JSON schema,
  and the consumer-less `@lxe/gateway` root entry point (`./desktop` remains).
- Agent runtime: the transcript v1 compatibility scaffolding. Legacy transcript
  blocks/events and pre-transcript `session_messages/*.jsonl` stores now fail
  with an explicit error pointing at `scripts/migrate-transcripts-v2.ts`
  (migration ran on 2026-07-15, see `20260715-transcript-v2.md`) instead of
  being silently accepted. The migration helpers moved into that script. The
  frozen-main parity fixtures are retired; their still-relevant provider cases
  now live in `test/providers/provider-cases.json` as ordinary test data.
- Dashboard: unused `mergeSessionLists` and `formatIsoDate` helpers.
- Python lxeskill: the empty `services.amazon` package, `shared/infra/artifact_io.py`,
  the unused LLM/OCR requests session proxies, the direct `urllib3` pin (still
  present transitively via requests), and `pillow` moves to dev dependencies
  (only tests use it).
- Scripts and config: the orphaned installer-era `scripts/_dependencies.ps1`,
  the retired `dist/lxeskill` frozen distribution artifact, the unread
  `FEISHU_BOT_OPEN_ID` template key, and the no-op `LoggingController.flush()`
  with its call sites.

Structure impact: `packages/agent/runtime/test` no longer has a `fixtures`
directory, so the frozen set in `test_repo_structure.py` drops that entry.
