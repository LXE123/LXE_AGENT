# Windows ACL launcher

Adapted from DeepSeek Harness commit `639ed015397290b3745d163aafe02ffee4aa3f84`:
`packages/sandbox/sandbox-windows-acl/src` and `packages/subprocess/win32-process/src`.
The upstream MIT license is retained in LICENSE. This directory is vendored native
code, outside the Bun runtime bundle. Build it for Node with
`bun scripts/prepare-exec-sandbox.ts`; Koffi 3.1.1 is locked separately.

Local adaptations: relative imports, Node createRequire in place of DSH's lazy
loader, no Cordis/diagnostic-skill registration or DSH control pipe, LXE error
prefix, and TMPDIR alongside TMP/TEMP. Bun owns the wrapper's environment,
stdio, output persistence and cancellation. The Node helper owns Win32 handles,
restricted tokens, grants and the kill-on-close Job. Bun calls the internal
`--prepare-session <workspace> <temp> <data-root>` entry once per live session
and uses the existing paired workspace/temp SID arguments to reuse it for each
command. A third deterministic managed-state SID is granted only on the fixed
Python state roots; it is added to a child token only for a registered,
visible `visibility=business` command. Ordinary exec tokens never carry it.
After the session's processes stop, `--release-session <workspace> <temp>
<data-root>` revokes the private temporary grant and Bun removes the directory.
Command completion or mode changes do not revoke shared grants. Restart creates
a new random runtime path and SID; crash residue is not reused. The standalone
runner path without paired SIDs still creates and cleans up its own per-command
temporary child.

Workspace ACLs, inherited delete-child denies and Low labels persist by design.
The backend has DSH's partial write enforcement, including hardlink aliases,
Low-label effects on other processes and inherited pipe/PowerShell limitations.
It does not isolate reads, networking or process visibility. It never retries an
unrestricted command or repairs foreign ACLs. See the main permission-policy
document for product scope and native validation.
