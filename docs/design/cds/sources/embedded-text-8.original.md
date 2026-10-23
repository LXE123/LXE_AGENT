## Data visualization — the design layer

Color comes LAST. Most bad charts pick colors first. The procedure:

1. **Pick the form** from the table below — and sometimes the right form is
   not a chart.
2. **Assign color by its job** — categorical, sequential, diverging, or status.
   Never cycled; never a rainbow.
3. **Apply the mark specs** below — thin marks, surface gaps, recessive axes.
4. **Add a legend** for ≥2 series and direct labels for ≤4; a single series
   needs no legend (the title names it).
5. **Add hover** — crosshair+tooltip on line/area, per-mark tooltip on bar/dot.
6. **Render and look.** Check label collisions, overflow, dark mode.

### Choosing a form

| The data is… | Use | Not |
|---|---|---|
| A single current value (+ maybe a trend) | **Stat tile** — value + delta + sparkline | A one-bar bar chart |
| A handful of headline numbers | **KPI row** of stat tiles | A grouped bar chart |
| A single ratio against a limit | **Meter** (same-ramp track) | A 2-slice pie |
| More than ~7 classes that all matter | A **table** (or table + chart) | More colors |

If a chart is right, the data's job picks the type:

| Job | Form | Color job |
|---|---|---|
| Compare magnitude | bar / column; heatmap for a grid | sequential (one hue) |
| Trend over time | line; area for a single series | sequential or 1 categorical |
| Tell distinct series apart | grouped/stacked bar, multi-line | categorical |
| One series is the point, rest context | **emphasis** — highlight one, gray the rest | 1 hue + gray |
| Above/below a baseline; Δ to target | diverging bar or line vs baseline | diverging |
| Part-to-whole | stacked bar (horizontal for long names) | categorical |
| Before → after per item | dumbbell | 1 hue, 2 shades |

**Sequential is the safe default.** Categorical has a cost — it can bury the
one point that matters. If the story is "this one went up," that's emphasis
(one hue + gray), not categorical. Never solve "too many series" with more
hues: past 8, fold into "Other" or use small multiples.

### Categorical palette (Cove — fixed order, never cycled)

The 9th series is never a generated hue — it folds into "Other" or small
multiples. Canvas can't resolve CSS vars, so use these hex values directly in
Chart.js datasets. For HTML/SVG legends, wrap them in a token:
`background: var(--series-N, <hex>)`.

| Slot | Hue | Light | Dark |
|------|-----|-------|------|
| 1 | blue | #2a78d6 | #3987e5 |
| 2 | orange | #eb6834 | #d95926 |
| 3 | aqua | #1baf7a | #199e70 |
| 4 | yellow | #eda100 | #c98500 |
| 5 | magenta | #e87ba4 | #d55181 |
| 6 | green | #008300 | #008300 |
| 7 | violet | #6250d6 | #9085e9 |
| 8 | red | #e34948 | #e66767 |

**Sequential** (magnitude — heatmap, choropleth): one hue, light→dark. Default
blue. **Diverging** (polarity — delta, above/below): blue ↔ red with a neutral
gray midpoint (light #f0efec / dark #383835) — never a hue at the midpoint.

**Status** (state — good/warning/serious/critical): #0ca30c / #fab219 /
#ec835a / #d03b3b. Reserved; never "series 4". Always paired with an icon +
label, never color alone.

### Chart chrome — use the CDS tokens already on :root

These are already defined by `tokens.vanilla.css`; reference them directly.
For canvas (which can't resolve vars), read them once:
`getComputedStyle(document.documentElement).getPropertyValue('--text-muted')`.

| Role | Token | Light | Dark |
|---|---|---|---|
| Chart surface | `var(--surface-1)` | #fcfcfb | #1a1a19 |
| Primary ink (values, title) | `var(--text-primary)` | #0b0b0b | #f0efec |
| Secondary ink (legend, sub) | `var(--text-secondary)` | #52514e | #c3c2b7 |
| Muted (axis ticks, labels) | `var(--text-muted)` | #898781 | #898781 |
| Gridline (hairline) | — | #e1e0d9 | #2c2c2a |
| Baseline / axis line | — | #c3c2b7 | #383835 |
| Hairline border | `var(--border)` | rgba(11,11,11,0.10) | rgba(255,255,255,0.10) |

**Text wears text tokens, never the series color** — values, axis labels, and
legend text stay in primary/secondary/muted ink; a small colored square beside
the text carries identity.

### Mark specs

- **Bar/column**: ≤24px thick, 4px rounded data-end, square at baseline.
- **Line**: 2px stroke, round join/cap.
- **End-dot / marker**: ≥8px, filled with series color, 2px surface-color ring.
- **Area fill**: series hue at ~10% opacity.
- **Gridlines**: one-step-off-surface gray, 1px, recessive. No vertical
  gridlines on a time axis.
- **Surface gap**: 2px surface-color gap between touching marks (stacked
  segments, adjacent bars). Never a stroke around a mark.

### Non-negotiables

- **One y-axis.** Never a dual-axis chart. Two scales → two charts or indexed.
- **Color follows the entity, never its rank.** Filtering must not repaint.
- **Assign categorical hues in the fixed Cove order.**
- **Sequential = one hue. Diverging = two hues + gray midpoint.** No rainbow.
- **Hero number** (stat tile): one figure in `var(--font-voice)` (Anthropic
  Serif) ≥48px, tabular + lining numerals. Everything else stays sans with
  tabular figures.
