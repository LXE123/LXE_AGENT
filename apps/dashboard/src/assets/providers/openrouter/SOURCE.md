# OpenRouter provider icon

- Asset: `openrouter-glyph.svg` in this directory, and the inline glyph in
  `src/shared/ui/provider-brand-mark.tsx`
- Source: the official OpenRouter brand v2 glyph, served from OpenRouter's own
  site at https://openrouter.ai/brand/v2/openrouter-glyph-light.svg (light
  variant, brand purple `#7624F4`), retrieved 2026-08-24. The dark variant at
  `openrouter-glyph-dark.svg` uses brand lime `#C8FF00`.
- License: the OpenRouter logo is a trademark of OpenRouter; it is used in
  LXE Agent solely to identify the OpenRouter provider and is not relicensed
  as part of LXE Agent.

The glyph is stored inline as a single filled path so it can inherit
`currentColor` — light surfaces get the official purple `#7624F4`, dark
surfaces the official lime `#C8FF00` — used both at compact provider-mark
sizes and as the large watermark on the OpenRouter model card. The path data
is otherwise unmodified. The older Simple Icons "openrouter" arrows glyph is
the pre-rebrand logo and is intentionally not used.
