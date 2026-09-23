# Zhihui TMS Desktop Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a Desktop user configure Zhihui TMS account and password securely, explicitly enable production API calls, and inject only the validated settings into the CLI process.

**Architecture:** Extend the existing Desktop integration config and encrypted secrets store, setup protocol, IPC validation, settings UI, and localization. Keep the account in nonsecret settings and the password in encrypted Desktop secrets. The execution switch defaults off and is only sent as `1` when the integration is complete and explicitly enabled.

**Tech Stack:** TypeScript, React, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-philippines-design.md`

## Global Constraints

- No plaintext password in settings JSON, setup state, logs, catalog, or CLI arguments.
- `ZHIHUI_TMS_PRODUCTION_ENABLED` defaults to `0`; account/password are empty unless the integration is valid and enabled.
- Clearing the integration removes the stored password and disables production calls.
- Password patches may be left blank to retain the encrypted stored password.
- The Desktop UI must say this grants production API access and show a separate explicit enable control.
- Tests use fixture credentials only and must not call TMS.

---

### Task 1: Extend secure Desktop state and environment

**Files:** Desktop protocol, config model, secrets, validation, setup service, config-store tests.

- [x] Add `zhihui_tms` integration account and disabled-by-default production flag to settings; add password to encrypted secrets.
- [x] Validate save/clear, retain blank secret patches, expose only configured status, and inject the three CLI environment variables only when enabled and complete.
- [x] Test saved secret is absent from plaintext settings/state and that clear disables all injected values.

### Task 2: Add setup IPC and UI

**Files:** IPC validation, Dashboard settings model/shell/localizations, targeted tests.

- [x] Validate the new setup payload with bounded account/password lengths and a boolean production switch.
- [x] Add the Zhihui TMS integration section with account, password, explicit production enable control, save and clear flows.
- [x] Update Chinese/English text and test both states.

### Task 3: Verify and commit

- [x] Run focused Desktop config, Dashboard and protocol tests plus type checks affected by these files.
- [x] Inspect exact staged files and commit only this core Desktop configuration change on the current branch; do not push.
