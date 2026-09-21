# User Skill acceptance

Run from the repository root:

```sh
bun apps/dashboard/test/features/skills/user-skills-fixture-server.ts
```

Open the printed local URL. This fixture uses the real user-skill file service and UI components with disposable files. It has no model connection and counts attempted message sends.

Checked on macOS in a standalone Chromium browser (2026-09-17):

- Official, shared, valid user, disabled user, broken YAML and shadowed entries remain distinguishable. The two `official-demo` entries open different content. No detail exposes an enable switch; existing disabled state remains unchanged and blocks Use.
- Tabs appear as Skills, Tools, Connections, Models in both languages. The + menu still appends Add skill to a draft; Use preserves that draft and never sends automatically.
- Source/status badges stay compact and left-aligned. Skill preview typography matches conversation Markdown for headings, paragraphs, quotes, lists, code, links and tables; only the preview viewport and opening-title suppression differ.
- Skill categories and cards use neutral backgrounds without gradients or left accent bars; detail bodies share the dialog background. Icon colors and Markdown reading aids remain. Verify both light and dark themes.
- All skill sources share the same detail layout. Markdown is shown first, omitting only the opening H1 of SKILL.md; source and copy retain the full document and attached-file headings remain visible; source, copy and skill information are in More. Technical identity, category, source, path and commands are hidden until information is expanded. Official/shared entries have no recycle or Use action.
- More supports arrow keys, Home/End, Tab, outside click and Escape. Escape closes the menu before the dialog; closing the dialog returns focus to its card.
- Copy uses the selected file, including attached templates; clipboard rejection displays its actual message. Official references and user attachments render correctly; binary resources disable copy, and oversized content shows the truncation notice.
- English details remain usable at 390px and 320px, including wrapped descriptions, More and footer actions.
- External manifest edits cause stale-version deletion to show the actual error, refresh the content, and allow retry. Recycle closes the detail, removes the card and reports its recovery path.
- The browser run issued no `skills.user.setEnabled` calls and left the fixture's persisted disabled configuration byte-for-byte unchanged.

The fixture's `disabled-demo` is deliberately disabled through the file service during setup to check compatibility with existing installations; the Dashboard has no enable/disable operation. All fixture skills and recycle contents are disposable.

Automated coverage additionally checks stale mutation rejection, restart persistence, shared sources, canonical path activation, native file/exec creation and editing, and shared Python/Bun format fixtures.

## Windows native validation — 2026-09-14

Tested through SSH in an isolated Windows x64 worktree, with Bun 1.4.2 and Python 3.12.10 from that worktree's own virtual environment.

- At `6a33f9c0`: 101 related Bun tests and 81 Python tests passed. All workspace type checks and the Dashboard production build passed.
- Native file/exec tests created and validated instruction-only and scripted/template skills using Chinese and space-containing paths. Discovery, state persistence, stale-version rejection, activation and conversation drafts passed.
- An additional real C-drive skill / D-drive app-data test exposed `EXDEV` during recycling. Fix `664c2435` adds copy-and-version-check handling before source removal, retaining the recovery copy if removal fails.
- At `664c2435`: all 28 affected Bun tests passed, including the real cross-volume regression; the original standalone C→D case and all workspace type checks passed again.

This run verified Windows native processes, file operations, Dashboard interfaces and production compilation. It did not automate the Windows desktop GUI. The main checkout and user skills on the remote machine were left unchanged.
