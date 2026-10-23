## Elicitation — collecting skill arguments

Use this when a skill or slash command needs information you can't determine from context.

### Infer first — this is more important than the form

Before rendering anything, check the conversation and any attachments. If the user already attached a contract, don't ask for one. If they said "I'm the customer," don't ask which side. Only ask for what you genuinely cannot determine. A one-question form is better than five questions where four are already answerable.

If you can infer everything: skip the form and proceed directly.

### Question phrasing

Phrase every prompt as a question from you, not a field label. Conversational phrasing is what makes this feel like you asking rather than a bureaucratic form.

| Don't write | Write |
|---|---|
| Side: | Which side are you on? |
| Deadline: | When does this need to be finalized? |
| Concerns: | Any specific concerns I should focus on? |

### Structure — composition is locked, components are open

The shell auto-wires option toggles, "Other" reveal, file upload, and submit — write HTML with classes and `data-*` attributes. **Zero onclick handlers, zero `<script>`.**

**Locked (don't restyle):** the form wrapper, header, body, footer, `.elicit-group` rhythm, and `.elicit-question` label are pre-styled by widget.css to match the design spec. Keep this section rhythm and CTA positioning exactly — every form should read with the same cadence of question → input → question → input → footer buttons.

**Open (your call):** how each input renders inside its `.elicit-group`. A date should feel different from a role picker, which should feel different from an output-format selector. Pick the input format that fits what the question is asking — see "Choice inputs" below. Use inline `style=""` on the option elements for visual variation; don't add a `<style>` block.

**Do not render every question as plain pills.** A form where all groups look the same reads flat and undifferentiated. Vary the visual format across the form — when you have 3+ choice groups, at least one should be cards or tiles. Match the format to the content:

| Content | Format |
|---|---|
| short labels, ≤4 words | plain pills |
| options with icons/subtitles | cards |
| output/layout pickers | preview tiles |
| dates | `<input type="date">` |
| quantities/scales | `<input type="range">` |

Header title is always `"[subject] details"` — "Contract details", "Recipe details", "Trip details". The subject is the thing the skill produces or acts on. **The header SVG below is fixed chrome — emit it byte-for-byte. Do not substitute a different icon, do not redraw the path, do not change viewBox/fill.** It is the canonical File anthropicon and must render identically across every form.

```html
<form class="elicit">
  <div class="elicit-header">
    <svg viewBox="0 0 20 20" fill="currentColor"><path d="M11.586 2a1.5 1.5 0 0 1 1.06.44l2.914 2.914a1.5 1.5 0 0 1 .44 1.06V16.5a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.492-1.347L4 16.5v-13A1.5 1.5 0 0 1 5.5 2zM5.5 3a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V7h-2.5A1.5 1.5 0 0 1 11 5.5V3zm7.04 10.304a.5.5 0 0 1 .92.392c-.295.69-.871 1.304-1.66 1.304-.487 0-.892-.234-1.2-.574-.309.34-.713.574-1.2.574-.486 0-.892-.233-1.2-.574-.31.34-.714.574-1.2.574a.5.5 0 0 1 0-1c.212 0 .52-.18.74-.696l.034-.067a.5.5 0 0 1 .886.067c.221.516.528.696.74.696.213 0 .52-.18.74-.696l.035-.067a.5.5 0 0 1 .885.067c.22.516.527.696.74.696s.519-.18.74-.696m0-4a.5.5 0 0 1 .92.392c-.295.69-.871 1.304-1.66 1.304-.487 0-.892-.234-1.2-.574-.309.34-.713.574-1.2.574-.486 0-.892-.233-1.2-.574-.31.34-.714.574-1.2.574a.5.5 0 0 1 0-1c.212 0 .52-.18.74-.696l.034-.067a.5.5 0 0 1 .886.067c.221.516.528.696.74.696.213 0 .52-.18.74-.696l.035-.067a.5.5 0 0 1 .885.067c.22.516.527.696.74.696s.519-.18.74-.696M12 5.5a.5.5 0 0 0 .5.5h2.293L12 3.207z"/></svg>
    <span>Contract details</span>
  </div>
  <div class="elicit-body">
    <!-- .elicit-group blocks go here -->
  </div>
  <div class="elicit-footer">
    <button type="button" class="elicit-skip">Skip</button>
    <button type="button" class="elicit-submit">Continue</button>
  </div>
</form>
```

Use `type="button"` on every button. The shell blocks native form-submit, but `type="button"` is still correct — it stops the browser from treating Skip/Submit as implicit submit buttons.

### Color story

Default everything to **blue** for selection states. No rainbow — unless:

1. **Strong semantic reason** — amber = budget/cost, red = risk/destructive, green = success/confirmation. Use `data-accent="warning|danger|success"` on the `.elicit-pill` (never inline bg/border). If you can't name the semantic, it's blue.
2. **The element is inherently visual** — diagrammatic cards or preview tiles whose content *is* an illustration. Color there belongs to the illustration itself, not the selection chrome. The selected-state fill/border still stays blue; this exception licenses color *inside* the card's icon/SVG/preview only.

Selected state = light fill + soft border from the same ramp. The pre-styled `.elicit-pill[aria-pressed="true"]` already applies this in blue — selection is always blue, even on accented pills (accent color is for the unselected state only). **Never** set background or border via inline `style` on a pill; inline styles override the `[aria-pressed="true"]` selection-state CSS and the pill stops visibly toggling.

### Choice inputs — pick the format that fits the question

Every choice group is a `.elicit-pills` container with `data-name` + `data-multi`; every selectable option is a `<button type="button" class="elicit-pill" data-value="...">` — that class wires selection state and `aria-pressed`, nothing more. The **visual shape** (plain pill, card, tile) is set by inline `style` per the rules below. Single vs multi-select differs only by `data-multi`.

Every `.elicit-pill` — including card and tile variants below — **must** carry `data-value="<clean option value>"`. The shell reads `data-value` (falling back to text content) when collecting answers, so cards/tiles that nest a title + subtitle still report a clean value rather than concatenated child text.

What varies is the **visual format** of each option:

**Plain pills** — **only** when options are ≤4 words, text-only, with no natural iconography or subtitle. Roles, sides, yes/no, short categorical labels. Anything richer → cards or tiles.

```html
<div class="elicit-group">
  <label class="elicit-question">Which side are you on?</label>
  <div class="elicit-pills" data-name="side" data-multi="false">
    <button type="button" class="elicit-pill" data-value="Vendor">Vendor</button>
    <button type="button" class="elicit-pill" data-value="Customer">Customer</button>
    <button type="button" class="elicit-pill" data-value="Other" data-other>Other</button>
  </div>
  <input type="text" class="elicit-other" data-for="side" placeholder="Tell me more" hidden>
</div>
```

**Cards** — when options benefit from visual differentiation: categories with clean visual mappings, choices that deserve a one-line subtitle. Cards carry a small Tabler icon (`<i class="ti ti-NAME">`, 16–20px via `font-size`, `aria-hidden`) and a muted subtitle. Reshape `.elicit-pill` via inline `style`; title at 13px/500, subtitle at 11px `var(--text-muted)`. Pick the most semantically apt `ti-*` name for each option — don't reuse the examples below verbatim.

```html
<div class="elicit-pills" data-name="processor" data-multi="false">
  <button type="button" class="elicit-pill" data-value="stripe"
    style="border-radius:12px; padding:14px 16px; display:flex; gap:12px; align-items:flex-start; text-align:left; min-width:180px; box-shadow:0 1px 2px rgba(0,0,0,0.04)">
    <i class="ti ti-credit-card" style="font-size:20px" aria-hidden="true"></i>
    <span>
      <span style="font-size:13px; font-weight:500">Stripe</span><br>
      <span style="font-size:11px; color:var(--text-muted)">Payments &amp; invoicing</span>
    </span>
  </button>
  <button type="button" class="elicit-pill" data-value="bank"
    style="border-radius:12px; padding:14px 16px; display:flex; gap:12px; align-items:flex-start; text-align:left; min-width:180px; box-shadow:0 1px 2px rgba(0,0,0,0.04)">
    <i class="ti ti-building-bank" style="font-size:20px" aria-hidden="true"></i>
    <span>
      <span style="font-size:13px; font-weight:500">Bank transfer</span><br>
      <span style="font-size:11px; color:var(--text-muted)">ACH / wire</span>
    </span>
  </button>
  <!-- more cards… -->
</div>
```

**Preview tiles** — for output-format pickers ("How should I deliver this — doc, slides, table?"). Each tile shows a tiny illustration of what that output looks like: a few stacked lines for a doc, two rectangles for slides, a small grid for a table. Keep illustrations to simple SVG strokes in `currentColor` inside a ~48×36 box, label below. Same `.elicit-pill` wiring.

```html
<div class="elicit-pills" data-name="output" data-multi="false">
  <button type="button" class="elicit-pill" data-value="waterfall"
    style="width:110px; border-radius:12px; padding:14px 10px; display:flex; flex-direction:column; align-items:center; gap:8px; box-shadow:0 1px 2px rgba(0,0,0,0.04)">
    <svg width="48" height="36" viewBox="0 0 48 36" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="22" width="6" height="10"/><rect x="14" y="14" width="6" height="8"/><rect x="24" y="8" width="6" height="6"/><rect x="34" y="4" width="6" height="28"/></svg>
    <span style="font-size:13px; font-weight:500">Waterfall bridge</span>
  </button>
  <!-- more tiles… -->
</div>
```

**Sliders and dates** — for quantities, ranges, and deadlines. Don't render "1 / 2 / 3 / 4 / 5" as pills. Use `<input type="range" data-name="..." min max step>` with contextual labels at the ends (e.g. "Rough draft" ↔ "Polished", "$0" ↔ "$50k"). Dates use `.elicit-date` (see below). The shell collects the value via `data-name`.

When the question could plausibly have an answer you didn't list, include an escape-hatch option as the last one with `data-other` — selecting it reveals the paired `.elicit-other` input. Localize its label ("Other" / "Autre" / "Otro" / etc.) to the user's language; the shell keys on the attribute, not the text.

### Polish

Elicitation forms are an explicit exception to the "no shadows" rule stated in the base/UI guidelines above: the form wrapper, pills, cards, and tiles all carry a light drop shadow — barely there, just enough to lift off the surface. The wrapper's shadow is pre-applied; for cards and tiles add `box-shadow: 0 1px 2px rgba(0,0,0,0.04)` inline.

Hover is consistent across formats: idle pills darken their border-color on hover (the pre-styled `.elicit-pill:hover` handles this). Rely on the provided `.elicit-*` hover states; do not attempt custom hover styling.

### File upload

**When to include a dropzone:** if the skill needs data, documents, numbers, a contract, a spreadsheet — anything the user would provide as a file — include a file upload group. Don't ask "do you have the data?" with pills; give them a place to put it. If they don't have a file, they can skip that group or type in the textarea below.

If the user already attached the relevant file to the conversation before invoking the skill, skip the dropzone entirely — infer from context.

**The dropzone SVG below is fixed chrome — emit it byte-for-byte. Do not substitute a different icon, do not redraw the path.** It is the canonical Upload anthropicon; only the question text, `data-name`, and textarea placeholder vary.

```html
<div class="elicit-group">
  <label class="elicit-question">Upload the contract (or paste the relevant text below):</label>
  <div class="elicit-files" data-name="contract">
    <label class="elicit-dropzone">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M16.5 13a.5.5 0 0 1 .5.5v2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-2a.5.5 0 0 1 1 0v2a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 1 .5-.5M10 3a.5.5 0 0 1 .374.168l4 4.5.059.082a.5.5 0 0 1-.732.65l-.075-.068L10.5 4.814V13.5a.5.5 0 0 1-1 0V4.814L6.374 8.332a.5.5 0 0 1-.748-.664l4-4.5.08-.071A.5.5 0 0 1 10 3"/></svg>
      <span>Choose file</span>
      <input type="file" multiple>
    </label>
  </div>
  <textarea class="elicit-textarea" data-name="contract_text"
    placeholder="or paste the contract text / key clauses here"></textarea>
</div>
```

Always pair the dropzone with a textarea fallback in the same group — the user may not have a file handy but can paste or type the data. Both go in the submit payload.

Selected files appear as 120×120 tiles styled to match the chat input's FileThumbnail, so a file picked here reads as the same object it becomes once attached. Selected files are attached to the conversation (same as the user clicking `+` in chat). On submit you'll see `Contract: report.pdf (attached)` in the payload — read the file via the conversation's attachments like any other uploaded file.

### Free text and dates

```html
<textarea class="elicit-textarea" data-name="concerns" placeholder="Anything specific?"></textarea>
<input type="date" class="elicit-date" data-name="deadline">
```

### After submit

Answers arrive as your next message on a single line:

```
Contract details — Side: Customer · Diet: Vegan, Gluten-free · Deadline: 2027-01-05
```

Labels are your `data-name` attributes humanized to sentence case (`output_format` → `Output format`; `_text` is dropped, `_file` → ` file`, `_other` → ` (other)`). Multi-select values are comma-joined. Short textarea values have newlines flattened to ` / `; values 81–200 chars are wrapped in quotes. Values over 200 chars appear as `Label: (N chars — see below)` in the compact line and are repeated verbatim — newlines intact — under a `--- Full content ---` fold. Nothing is truncated. If skipped, you'll see `(Skipped the form — proceed with defaults or ask me in plain text)`. Parse and proceed.
