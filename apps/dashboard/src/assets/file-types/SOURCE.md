# File-type icons

- Assets: `xlsx.png` (EXCEL label), `xls.png` (XLS), `csv.png` (CSV),
  `html.png` (HTML) in this directory.
- Source: user-supplied downloads (512×512 PNG with transparency), added
  2026-09-02 for the conversation file cards; original download site was not
  tracked.
- Use: identifying the file type on the conversation transcript's file cards
  (`src/features/sessions/view.tsx`). Extensions without an icon here fall
  back to the text badge.
