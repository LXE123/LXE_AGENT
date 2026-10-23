<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Visualize Widget</title>
  <style id="mcp-host-fonts">/* Fonts injected from hostContext.styles.css.fonts */</style>
  <style>:root{--font-anthropic-sans:"anthropic-sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;--font-anthropic-serif:"anthropic-serif", ui-serif, Georgia, "Times New Roman", serif}/* The --font-anthropic-* override vars the CDS font tokens resolve are
   NOT declared here: build-widgets.ts generates them into this style
   tag from @ant/typography's canonical family names
   (fonts/AnthropicFonts/families.ts), and asserts the @font-face names
   below match — so this file can't silently drift from the names the
   rest of the suite registers. This document can't consume the central
   @font-face sheets themselves (package-relative url()s; these faces
   are CDN statics, and the sans faces arrive via #mcp-host-fonts at
   runtime), so it centralizes the NAMES instead. */

@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-Regular-Static.otf")
    format("opentype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-RegularItalic-Static.otf")
    format("opentype");
  font-weight: 400;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-Medium-Static.otf")
    format("opentype");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-MediumItalic-Static.otf")
    format("opentype");
  font-weight: 500;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-Semibold-Static.otf")
    format("opentype");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-SemiboldItalic-Static.otf")
    format("opentype");
  font-weight: 600;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-Bold-Static.otf")
    format("opentype");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "anthropic-serif";
  src: url("https://assets.claude.ai/Fonts/AnthropicSerif-Text-BoldItalic-Static.otf")
    format("opentype");
  font-weight: 700;
  font-style: italic;
  font-display: swap;
}</style>
  <style>/**
 * GENERATED — do not edit. Run `yarn workspace @ant/cds gen:tokens`.
 *
 * Framework-agnostic CDS token export: unprefixed `--*` custom
 * properties under `:root`, light by default, dark on screen under
 * `[data-mode="dark"]` and under `@media (prefers-color-scheme: dark)`
 * unless the root element says `data-mode="light"`. No `.cds-root`
 * scoping, density steps, or component-private tokens.
 *
 * `data-mode` on any element below the root makes its subtree an island
 * in that mode (nearest one wins, any depth). That is why the tokens whose
 * value depends on the mode — var() aliases such as `--page-bg` included —
 * sit in a rule of their own whose selector list is `:root` AND the three
 * island selectors: declared once, they re-resolve on every island as on
 * the root (do not fold that rule back into `:root`: an alias declared
 * only on the root is inherited into an island already resolved). The
 * platform-dependent tokens share a rule with `[data-platform="web"|
 * "desktop"]` the same way. All rules are (0,1,0), later wins: a host that
 * overrides a token on `:root` and wants it inside islands too writes
 * `:root, [data-mode] { … }` after this sheet. An island (never the root,
 * whose scheme stays the host's) also gets the `color-scheme` its mode
 * names, so native controls and `light-dark()` follow the palette there;
 * those three rules are (0,2,0) for their `:not(:root)`.
 *
 * Source: `packages/cds/tokens/`. For the full React/Tailwind build
 * (scoped under `.cds-root`), see `tokens.css`.
 *
 * `--font-mono` carries an EMPTY var() fallback (`var(--font-mono-
 * override,)` — spec-legal, css-variables-1 §2.3): if you set
 * `--font-mono-override`, the value MUST be a comma-terminated family
 * list (e.g. `"Georgia",`) — without the trailing comma it fuses with
 * the stack's first family into an invalid name and font-family
 * silently breaks.
 */

:root {
  --radius: calc(0.5rem * var(--cds-rem-scale, 1));
  --radius-composer: calc(0.875rem * var(--cds-rem-scale, 1));
  --h-control: calc(2rem * var(--cds-rem-scale, 1));
  --h-control-nested: calc(1.375rem * var(--cds-rem-scale, 1));
  --icon: calc(1.25rem * var(--cds-rem-scale, 1));
  --pad-xs: calc(0.375rem * var(--cds-rem-scale, 1));
  --pad-sm: calc(0.5rem * var(--cds-rem-scale, 1));
  --pad-md: calc(0.75rem * var(--cds-rem-scale, 1));
  --pad-lg: calc(1rem * var(--cds-rem-scale, 1));
  --pad-xl: calc(1.5rem * var(--cds-rem-scale, 1));
  --gap-xs: calc(0.5rem * var(--cds-rem-scale, 1));
  --gap-sm: calc(0.75rem * var(--cds-rem-scale, 1));
  --gap-md: calc(1rem * var(--cds-rem-scale, 1));
  --gap-lg: calc(1.75rem * var(--cds-rem-scale, 1));
  --gap-xl: calc(2.5rem * var(--cds-rem-scale, 1));
  --outset-x: 0px;
  --outset-y: 0px;
  --border-editor-comment-target: var(--yellow-450);
  --shadow-drop-ring: inset 0 0 0 2px var(--fill-accent);
  --shadow-drop-ring-danger: inset 0 0 0 2px var(--fill-danger);
  --shadow-drop-glow: inset 0 0 24px -2px hsl(from var(--fill-accent) h s l / 20%);
  --shadow-drop-glow-danger: inset 0 0 24px -2px hsl(from var(--fill-danger) h s l / 20%);
  --ring-hairline: 1px;
  --font-mono: var(--font-mono-override,) var(--font-anthropic-mono, "SF Mono"), "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --font-mono-ui: var(--font-anthropic-mono, "SF Mono"), "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --font-system: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "PingFang TC", "Hiragino Sans", "Apple SD Gothic Neo", sans-serif;
  --font-sans: var(--font-anthropic-sans, var(--font-system)), var(--font-system);
  --font-sans-display: var(--font-anthropic-sans-display, var(--font-sans)), var(--font-sans);
  --font-voice: var(--font-anthropic-serif, ui-serif), ui-serif, Georgia, "Times New Roman", serif;
  --ease-out: cubic-bezier(0.165, 0.84, 0.44, 1);
  --ease-snap: cubic-bezier(0.32, 0.72, 0, 1);
  --ease-overshoot: cubic-bezier(0.34, 1.3, 0.64, 1);
  --dur-fast: 60ms;
  --dur-snap: 120ms;
  --dur-base: 200ms;
  --dur-sheet: 300ms;
  --dur-slow: 450ms;
  --btn-spring: linear(0, 0.2459, 0.6526, 0.9468, 1.0764, 1.0915, 1.0585, 1.0219, 0.9993, 0.9914, 0.9921, 0.9957, 0.9988, 1.0004, 1);
  --black: #000000;
  --oncolor-200: hsl(60 6.7% 97.1% / 0.75);
  --oncolor-300: hsl(60 6.7% 97.1% / 0.5);
  --clay: #d97757;
  --clay-emphasized: #c6613f;
  --heather: #cbcadb;
  --plum: #827dbd;
  --cactus: #bcd1ca;
  --mineral: #629987;
  --gray-0: #ffffff;
  --gray-10: #fcfcfb;
  --gray-20: #f9f9f7;
  --gray-30: #f6f6f4;
  --gray-40: #f3f3f0;
  --gray-50: #f0efec;
  --gray-60: #edece8;
  --gray-70: #eae9e4;
  --gray-80: #e7e6e1;
  --gray-90: #e4e3dd;
  --gray-100: #e1e0d9;
  --gray-150: #d2d1c7;
  --gray-200: #c3c2b7;
  --gray-250: #b4b3a8;
  --gray-300: #a5a49a;
  --gray-350: #97958d;
  --gray-400: #898781;
  --gray-450: #7b7974;
  --gray-500: #6d6b67;
  --gray-550: #5f5e5a;
  --gray-600: #52514e;
  --gray-650: #454442;
  --gray-700: #383835;
  --gray-750: #2c2c2a;
  --gray-800: #20201f;
  --gray-810: #1e1e1d;
  --gray-820: #1c1c1b;
  --gray-830: #1a1a19;
  --gray-840: #181817;
  --gray-850: #151515;
  --gray-860: #131313;
  --gray-870: #111111;
  --gray-880: #0f0f0f;
  --gray-890: #0d0d0d;
  --gray-900: #0b0b0b;
  --red-0: #ffffff;
  --red-10: #fffbfb;
  --red-20: #fef7f7;
  --red-30: #fef3f3;
  --red-40: #fdefef;
  --red-50: #fbebeb;
  --red-60: #fae7e7;
  --red-70: #fae3e3;
  --red-80: #fadfdf;
  --red-90: #fadada;
  --red-100: #fad6d6;
  --red-150: #f7c1c1;
  --red-200: #f4abab;
  --red-250: #f09595;
  --red-300: #ec7e7e;
  --red-350: #e66767;
  --red-400: #e34948;
  --red-450: #d03b3b;
  --red-500: #b93535;
  --red-550: #a32c2c;
  --red-600: #8e2626;
  --red-650: #791e1e;
  --red-700: #641919;
  --red-750: #511212;
  --red-800: #3c0e0e;
  --red-810: #380d0d;
  --red-820: #340c0c;
  --red-830: #310b0b;
  --red-840: #2d0a0a;
  --red-850: #280a0a;
  --red-860: #230b0a;
  --red-870: #1d0b0a;
  --red-880: #170c0b;
  --red-890: #110c0b;
  --red-900: #0b0b0b;
  --orange-0: #ffffff;
  --orange-10: #fefbfa;
  --orange-20: #fdf7f5;
  --orange-30: #fcf4f0;
  --orange-40: #faf0ec;
  --orange-50: #f9ece7;
  --orange-60: #f8e9e2;
  --orange-70: #f7e5dd;
  --orange-80: #f7e1d7;
  --orange-90: #f7dcd1;
  --orange-100: #f7d8cb;
  --orange-150: #f3c5b2;
  --orange-200: #f4ae94;
  --orange-250: #f09978;
  --orange-300: #ec835a;
  --orange-350: #eb6834;
  --orange-400: #d95926;
  --orange-450: #c25124;
  --orange-500: #ae461c;
  --orange-550: #993d19;
  --orange-600: #863311;
  --orange-650: #712b0f;
  --orange-700: #5d230b;
  --orange-750: #4b1b08;
  --orange-800: #371407;
  --orange-810: #341307;
  --orange-820: #301106;
  --orange-830: #2d1006;
  --orange-840: #290f06;
  --orange-850: #240e07;
  --orange-860: #1f0e08;
  --orange-870: #1a0e09;
  --orange-880: #150d0a;
  --orange-890: #100c0b;
  --orange-900: #0b0b0b;
  --yellow-0: #ffffff;
  --yellow-10: #fefcf8;
  --yellow-20: #fcf8f1;
  --yellow-30: #fbf5ea;
  --yellow-40: #f9f2e4;
  --yellow-50: #f9eeda;
  --yellow-60: #faebce;
  --yellow-70: #fae7c2;
  --yellow-80: #fae3b8;
  --yellow-90: #f9e0b0;
  --yellow-100: #f9dca4;
  --yellow-150: #f9c868;
  --yellow-200: #fab219;
  --yellow-250: #eda100;
  --yellow-300: #db9300;
  --yellow-350: #c98500;
  --yellow-400: #b77700;
  --yellow-450: #a66a00;
  --yellow-500: #945d00;
  --yellow-550: #835100;
  --yellow-600: #734500;
  --yellow-650: #623900;
  --yellow-700: #512e00;
  --yellow-750: #412400;
  --yellow-800: #311a00;
  --yellow-810: #2e1800;
  --yellow-820: #2b1700;
  --yellow-830: #271500;
  --yellow-840: #231402;
  --yellow-850: #1f1204;
  --yellow-860: #1b1106;
  --yellow-870: #171007;
  --yellow-880: #130e09;
  --yellow-890: #0f0d0a;
  --yellow-900: #0b0b0b;
  --green-0: #ffffff;
  --green-10: #fafdfa;
  --green-20: #f5fbf4;
  --green-30: #f0f9ef;
  --green-40: #ebf7e9;
  --green-50: #e5f4e4;
  --green-60: #e0f2de;
  --green-70: #dbf0d8;
  --green-80: #d5eed3;
  --green-90: #d0eccd;
  --green-100: #caeac7;
  --green-150: #aee0a9;
  --green-200: #91d68b;
  --green-250: #73cb6d;
  --green-300: #55bf50;
  --green-350: #35b231;
  --green-400: #0ca30c;
  --green-450: #009300;
  --green-500: #008300;
  --green-550: #007300;
  --green-600: #006300;
  --green-650: #005400;
  --green-700: #074506;
  --green-750: #0f350d;
  --green-800: #11260f;
  --green-810: #10230f;
  --green-820: #10210f;
  --green-830: #101e0f;
  --green-840: #101b0f;
  --green-850: #0f180e;
  --green-860: #0e160e;
  --green-870: #0e130d;
  --green-880: #0d100d;
  --green-890: #0c0e0c;
  --green-900: #0b0b0b;
  --aqua-0: #ffffff;
  --aqua-10: #f9fdfb;
  --aqua-20: #f3fbf8;
  --aqua-30: #edf9f4;
  --aqua-40: #e8f7f1;
  --aqua-50: #e2f4ed;
  --aqua-60: #dcf2ea;
  --aqua-70: #d5f0e6;
  --aqua-80: #ceefe2;
  --aqua-90: #c7eddf;
  --aqua-100: #bfebdb;
  --aqua-150: #a0e1c9;
  --aqua-200: #7ad7b4;
  --aqua-250: #5acba0;
  --aqua-300: #3bbd8c;
  --aqua-350: #1baf7a;
  --aqua-400: #199e70;
  --aqua-450: #138e65;
  --aqua-500: #0f7e5c;
  --aqua-550: #0e6e53;
  --aqua-600: #065f49;
  --aqua-650: #095040;
  --aqua-700: #034235;
  --aqua-750: #02342b;
  --aqua-800: #022720;
  --aqua-810: #02241e;
  --aqua-820: #02221c;
  --aqua-830: #021f1a;
  --aqua-840: #031c18;
  --aqua-850: #051a16;
  --aqua-860: #071713;
  --aqua-870: #081411;
  --aqua-880: #0a110f;
  --aqua-890: #0b0e0d;
  --aqua-900: #0b0b0b;
  --blue-0: #ffffff;
  --blue-10: #fafcff;
  --blue-20: #f5f9fe;
  --blue-30: #f0f7fe;
  --blue-40: #ebf4fc;
  --blue-50: #e7f1fb;
  --blue-60: #e2eefa;
  --blue-70: #ddebfa;
  --blue-80: #d7e8fa;
  --blue-90: #d2e5fa;
  --blue-100: #cde2fb;
  --blue-150: #b7d3f6;
  --blue-200: #9ec5f4;
  --blue-250: #86b6ef;
  --blue-300: #6da7ec;
  --blue-350: #5598e7;
  --blue-400: #3987e5;
  --blue-450: #2a78d6;
  --blue-500: #256abf;
  --blue-550: #1c5cab;
  --blue-600: #184f95;
  --blue-650: #104281;
  --blue-700: #0d366b;
  --blue-750: #062b57;
  --blue-800: #032042;
  --blue-810: #031e3d;
  --blue-820: #021c39;
  --blue-830: #021a36;
  --blue-840: #021831;
  --blue-850: #03162c;
  --blue-860: #051426;
  --blue-870: #07121f;
  --blue-880: #091018;
  --blue-890: #0a0d11;
  --blue-900: #0b0b0b;
  --violet-0: #ffffff;
  --violet-10: #fcfbff;
  --violet-20: #f8f8ff;
  --violet-30: #f5f4ff;
  --violet-40: #f2f1ff;
  --violet-50: #efedff;
  --violet-60: #ebeafe;
  --violet-70: #e8e6fe;
  --violet-80: #e5e2fd;
  --violet-90: #e2dffd;
  --violet-100: #dfdbfd;
  --violet-150: #cfcafb;
  --violet-200: #bfb9f5;
  --violet-250: #b0a7f2;
  --violet-300: #a096eb;
  --violet-350: #9085e9;
  --violet-400: #8173e3;
  --violet-450: #7161e0;
  --violet-500: #6250d6;
  --violet-550: #5645be;
  --violet-600: #4a3aa7;
  --violet-650: #3e318e;
  --violet-700: #322777;
  --violet-750: #271e60;
  --violet-800: #1d1649;
  --violet-810: #1b1544;
  --violet-820: #19133f;
  --violet-830: #17123b;
  --violet-840: #151036;
  --violet-850: #130f32;
  --violet-860: #110e2b;
  --violet-870: #0f0e23;
  --violet-880: #0e0d1b;
  --violet-890: #0c0c13;
  --violet-900: #0b0b0b;
  --magenta-0: #ffffff;
  --magenta-10: #fefbfc;
  --magenta-20: #fef6f9;
  --magenta-30: #fdf2f6;
  --magenta-40: #fbeff3;
  --magenta-50: #faebf0;
  --magenta-60: #f9e6ed;
  --magenta-70: #f9e2eb;
  --magenta-80: #f9dee8;
  --magenta-90: #f9d9e5;
  --magenta-100: #f9d4e2;
  --magenta-150: #f3c0d3;
  --magenta-200: #f3a8c3;
  --magenta-250: #ed93b4;
  --magenta-300: #e87ba4;
  --magenta-350: #e46191;
  --magenta-400: #d55181;
  --magenta-450: #c04873;
  --magenta-500: #ad3d66;
  --magenta-550: #993458;
  --magenta-600: #862a4c;
  --magenta-650: #722340;
  --magenta-700: #5e1c34;
  --magenta-750: #4c1429;
  --magenta-800: #390f1f;
  --magenta-810: #360d1c;
  --magenta-820: #320c1a;
  --magenta-830: #2f0b18;
  --magenta-840: #2b0a16;
  --magenta-850: #270a14;
  --magenta-860: #220a12;
  --magenta-870: #1c0b11;
  --magenta-880: #170b0f;
  --magenta-890: #110b0d;
  --magenta-900: #0b0b0b;
  --role-accent-50: var(--blue-50);
  --role-accent-100: var(--blue-100);
  --role-accent-250: var(--blue-250);
  --role-accent-300: var(--blue-300);
  --role-accent-400: var(--blue-400);
  --role-accent-450: var(--blue-450);
  --role-accent-600: var(--blue-600);
  --role-accent-700: var(--blue-700);
  --role-accent-800: var(--blue-800);
  --role-accent-850: var(--blue-850);
  --role-accent-fill: var(--role-accent-450);
  --role-accent-fill-hover: var(--role-accent-400);
  --role-accent-on: var(--gray-0);
  --role-danger-100: var(--red-100);
  --role-danger-250: var(--red-250);
  --role-danger-300: var(--red-300);
  --role-danger-400: var(--red-400);
  --role-danger-450: var(--red-450);
  --role-danger-600: var(--red-600);
  --role-danger-700: var(--red-700);
  --role-danger-800: var(--red-800);
  --role-danger-fill: var(--role-danger-450);
  --role-danger-fill-hover: var(--role-danger-400);
  --role-danger-on: var(--gray-0);
  --role-success-100: var(--green-100);
  --role-success-250: var(--green-250);
  --role-success-400: var(--green-400);
  --role-success-450: var(--green-450);
  --role-success-600: var(--green-600);
  --role-success-700: var(--green-700);
  --role-success-800: var(--green-800);
  --role-success-fill: var(--role-success-450);
  --role-success-fill-hover: var(--role-success-400);
  --role-success-on: var(--gray-900);
  --role-warning-100: var(--yellow-100);
  --role-warning-200: var(--yellow-200);
  --role-warning-250: var(--yellow-250);
  --role-warning-300: var(--yellow-300);
  --role-warning-600: var(--yellow-600);
  --role-warning-700: var(--yellow-700);
  --role-warning-800: var(--yellow-800);
  --role-warning-fill: var(--role-warning-200);
  --role-warning-fill-hover: var(--role-warning-250);
  --role-warning-on: var(--gray-900);
  --role-pro-100: var(--violet-100);
  --role-pro-250: var(--violet-250);
  --role-pro-300: var(--violet-300);
  --role-pro-400: var(--violet-400);
  --role-pro-450: var(--violet-450);
  --role-pro-600: var(--violet-600);
  --role-pro-700: var(--violet-700);
  --role-pro-800: var(--violet-800);
  --role-pro-fill: var(--role-pro-450);
  --role-pro-fill-hover: var(--role-pro-400);
  --role-pro-on: var(--gray-0);
  --role-tooltip-bg: var(--gray-900);
  --role-tooltip-fg: var(--gray-0);
  --fill-accent: var(--role-accent-fill);
  --fill-accent-hover: var(--role-accent-fill-hover);
  --fill-danger: var(--role-danger-fill);
  --fill-danger-hover: var(--role-danger-fill-hover);
  --fill-success: var(--role-success-fill);
  --fill-success-hover: var(--role-success-fill-hover);
  --fill-warning: var(--role-warning-fill);
  --fill-warning-hover: var(--role-warning-fill-hover);
  --fill-pro: var(--role-pro-fill);
  --fill-pro-hover: var(--role-pro-fill-hover);
  --fill-brand: var(--clay-emphasized);
  --fill-brand-hover: var(--clay);
  --bg-accent-muted: color-mix(in srgb, var(--fill-accent) 10%, transparent);
  --bg-highlight: color-mix(in srgb, var(--fill-warning) 33%, transparent);
  --bg-editor-claude-pending: color-mix(in srgb, var(--clay) 22%, transparent);
  --bg-editor-highlight-yellow: var(--bg-highlight);
  --bg-editor-highlight-green: color-mix(in srgb, var(--green-300) 33%, transparent);
  --bg-editor-highlight-blue: color-mix(in srgb, var(--blue-300) 33%, transparent);
  --bg-editor-highlight-magenta: color-mix(in srgb, var(--magenta-300) 33%, transparent);
  --bg-editor-highlight-violet: color-mix(in srgb, var(--violet-300) 33%, transparent);
  --bg-editor-highlight-gray: color-mix(in srgb, var(--gray-300) 33%, transparent);
  --bg-editor-collaborator-1: color-mix(in srgb, var(--editor-collaborator-1) 22%, transparent);
  --bg-editor-collaborator-2: color-mix(in srgb, var(--editor-collaborator-2) 22%, transparent);
  --bg-editor-collaborator-3: color-mix(in srgb, var(--editor-collaborator-3) 22%, transparent);
  --bg-editor-collaborator-4: color-mix(in srgb, var(--editor-collaborator-4) 22%, transparent);
  --bg-editor-collaborator-5: color-mix(in srgb, var(--editor-collaborator-5) 22%, transparent);
  --bg-editor-collaborator-6: color-mix(in srgb, var(--editor-collaborator-6) 22%, transparent);
  --bg-editor-comment: color-mix(in srgb, var(--fill-warning) 20%, transparent);
  --bg-editor-comment-active: color-mix(in srgb, var(--fill-warning) 45%, transparent);
  --font-size-caption: calc(0.75rem * var(--cds-rem-scale, 1));
  --font-size-footnote: calc(0.8125rem * var(--cds-rem-scale, 1));
  --font-size-code: calc(0.8125rem * var(--cds-rem-scale, 1));
  --font-size-body: calc(0.875rem * var(--cds-rem-scale, 1));
  --font-size-prose: 1rem;
  --font-size-heading: calc(0.9375rem * var(--cds-rem-scale, 1));
  --font-size-title: calc(1.375rem * var(--cds-rem-scale, 1));
  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 580;
  --font-weight-bold: 600;
  --leading-caption: calc(1.0625rem * var(--cds-rem-scale, 1));
  --leading-footnote: calc(1.0625rem * var(--cds-rem-scale, 1));
  --leading-code: calc(1.1875rem * var(--cds-rem-scale, 1));
  --leading-body: calc(1.25rem * var(--cds-rem-scale, 1));
  --leading-prose: 1.5rem;
  --leading-heading: calc(1.25rem * var(--cds-rem-scale, 1));
  --leading-title: calc(1.75rem * var(--cds-rem-scale, 1));
  --on-accent: var(--role-accent-on);
  --on-danger: var(--role-danger-on);
  --on-success: var(--role-success-on);
  --on-warning: var(--role-warning-on);
  --on-pro: var(--role-pro-on);
  --on-brand: #ffffff;
  --editor-collaborator-1: var(--violet-450);
  --editor-collaborator-2: var(--magenta-450);
  --editor-collaborator-3: var(--aqua-500);
  --editor-collaborator-4: var(--green-500);
  --editor-collaborator-5: var(--yellow-500);
  --editor-collaborator-6: var(--gray-500);
  --opacity-disabled: 0.4;
  --opacity-icon-secondary: 0.4;
  --z-modal: 40;
  --z-coachmark: 35;
  --z-popover: 50;
  --z-tooltip: 50;
  --z-toast: 60;
}

:root,
[data-mode="light"],
[data-mode="dark"],
[data-mode="system"] {
  --border: var(--alpha-2);
  --border-accent: var(--role-accent-250);
  --border-danger: var(--role-danger-250);
  --border-success: var(--role-success-250);
  --border-warning: var(--role-warning-250);
  --border-pro: var(--role-pro-250);
  --border-editor-comment: var(--yellow-400);
  --border-editor-comment-open: var(--yellow-450);
  --border-git-added: color-mix(in srgb, var(--text-git-added) 40%, transparent);
  --border-git-removed: color-mix(in srgb, var(--text-git-removed) 40%, transparent);
  --border-git-modified: color-mix(in srgb, var(--text-git-modified) 40%, transparent);
  --border-git-merged: color-mix(in srgb, var(--text-git-merged) 40%, transparent);
  --border-git-closed: color-mix(in srgb, var(--text-git-closed) 40%, transparent);
  --border-git-conflicting: color-mix(in srgb, var(--text-git-conflicting) 40%, transparent);
  --border-git-draft: color-mix(in srgb, var(--text-git-draft) 40%, transparent);
  --border-git-opened: var(--border-git-added);
  --border-git-queued: var(--border-git-modified);
  --border-strong: var(--alpha-3);
  --border-stronger: hsl(from var(--neutral-900) h s l / 40%);
  --shadow-sm: 0 1px 2px 0 hsl(from var(--gray-900) h s l / 6%), 0 2px 8px 0 var(--shadow-color);
  --shadow-md: 0 2px 4px 0 hsl(from var(--gray-900) h s l / 7%), 0 6px 16px 0 var(--shadow-color);
  --shadow-lg: 0 4px 8px 0 hsl(from var(--gray-900) h s l / 8%), 0 12px 28px -2px var(--shadow-color);
  --shadow-color: hsl(from var(--gray-900) h s l / 8%);
  --shadow-popover: 0 8px 24px rgb(0 0 0 / 0.12), 0 2px 6px rgb(0 0 0 / 0.08);
  --ring-outer: 1px;
  --ring-inner: 0px;
  --ring-color: var(--border);
  --focus-shadow: inset 0 0 0 1px var(--page-bg), 0 0 0 1px var(--fill-accent), 0 0 6px 1px var(--bg-accent);
  --focus-shadow-danger: inset 0 0 0 1px var(--page-bg), 0 0 0 1px var(--fill-danger), 0 0 6px 1px var(--bg-danger);
  --pictogram-highlight-default: var(--gray-80);
  --pictogram-highlight-heather: var(--heather);
  --pictogram-highlight-cactus: var(--cactus);
  --neutral-0: var(--gray-0);
  --neutral-10: var(--gray-10);
  --neutral-20: var(--gray-20);
  --neutral-30: var(--gray-30);
  --neutral-40: var(--gray-40);
  --neutral-50: var(--gray-50);
  --neutral-60: var(--gray-60);
  --neutral-70: var(--gray-70);
  --neutral-80: var(--gray-80);
  --neutral-90: var(--gray-90);
  --neutral-100: var(--gray-100);
  --neutral-150: var(--gray-150);
  --neutral-200: var(--gray-200);
  --neutral-250: var(--gray-250);
  --neutral-300: var(--gray-300);
  --neutral-350: var(--gray-350);
  --neutral-400: var(--gray-400);
  --neutral-450: var(--gray-450);
  --neutral-500: var(--gray-500);
  --neutral-550: var(--gray-550);
  --neutral-600: var(--gray-600);
  --neutral-650: var(--gray-650);
  --neutral-700: var(--gray-700);
  --neutral-750: var(--gray-750);
  --neutral-800: var(--gray-800);
  --neutral-810: var(--gray-810);
  --neutral-820: var(--gray-820);
  --neutral-830: var(--gray-830);
  --neutral-840: var(--gray-840);
  --neutral-850: var(--gray-850);
  --neutral-860: var(--gray-860);
  --neutral-870: var(--gray-870);
  --neutral-880: var(--gray-880);
  --neutral-890: var(--gray-890);
  --neutral-900: var(--gray-900);
  --alpha-0: hsl(from var(--neutral-900) h s l / 0%);
  --alpha-1: hsl(from var(--neutral-900) h s l / 5%);
  --alpha-2: hsl(from var(--neutral-900) h s l / 10%);
  --alpha-3: hsl(from var(--neutral-900) h s l / 20%);
  --alpha-4: hsl(from var(--neutral-900) h s l / 35%);
  --alpha-5: hsl(from var(--neutral-900) h s l / 50%);
  --alpha-6: hsl(from var(--neutral-900) h s l / 60%);
  --alpha-7: hsl(from var(--neutral-900) h s l / 70%);
  --alpha-8: hsl(from var(--neutral-900) h s l / 85%);
  --alpha-9: hsl(from var(--neutral-900) h s l / 95%);
  --surface-0: var(--gray-20);
  --surface-1: var(--gray-10);
  --surface-2: var(--gray-0);
  --surface-3: var(--gray-0);
  --surface-popover: var(--surface-3);
  --surface-panel: var(--surface-2);
  --page-bg: var(--surface-0);
  --fill-git-added: #1a8633;
  --fill-git-added-hover: #1e9b3b;
  --fill-git-removed: var(--text-git-removed);
  --fill-git-removed-hover: #de295f;
  --fill-git-modified: #8b751c;
  --fill-git-modified-hover: #a08720;
  --fill-git-merged: #855fd6;
  --fill-git-merged-hover: #9473db;
  --fill-git-closed: #ed0b00;
  --fill-git-closed-hover: #ff1307;
  --fill-git-conflicting: #b85b19;
  --fill-git-conflicting-hover: #c5621b;
  --fill-git-draft: var(--text-git-draft);
  --fill-git-draft-hover: #808080;
  --fill-git-opened: var(--fill-git-added);
  --fill-git-opened-hover: var(--fill-git-added-hover);
  --fill-git-queued: var(--fill-git-modified);
  --fill-git-queued-hover: var(--fill-git-modified-hover);
  --fill-primary: var(--neutral-900);
  --fill-primary-hover: var(--neutral-750);
  --fill-secondary: hsl(0 0% 100% / 0.1);
  --fill-secondary-hover: var(--alpha-1);
  --fill-secondary-ring: var(--border);
  --fill-secondary-pressed-ring: var(--border);
  --fill-field: hsl(0 0% 100% / 0.5);
  --fill-field-ring: var(--border);
  --fill-ghost-hover: var(--alpha-1);
  --fill-ghost-selected: var(--alpha-2);
  --fill-disabled: var(--alpha-1);
  --fill-control: var(--alpha-2);
  --fill-control-hover: var(--alpha-3);
  --bg-accent: var(--role-accent-100);
  --bg-danger: var(--role-danger-100);
  --bg-success: var(--role-success-100);
  --bg-warning: var(--role-warning-100);
  --bg-pro: var(--role-pro-100);
  --bg-tint-red: rgb(from var(--red-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-red-opaque: var(--red-100);
  --bg-tint-orange: rgb(from var(--orange-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-orange-opaque: var(--orange-100);
  --bg-tint-yellow: rgb(from var(--yellow-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-yellow-opaque: var(--yellow-100);
  --bg-tint-green: rgb(from var(--green-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-green-opaque: var(--green-100);
  --bg-tint-aqua: rgb(from var(--aqua-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-aqua-opaque: var(--aqua-100);
  --bg-tint-blue: rgb(from var(--blue-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-blue-opaque: var(--blue-100);
  --bg-tint-violet: rgb(from var(--violet-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-violet-opaque: var(--violet-100);
  --bg-tint-magenta: rgb(from var(--magenta-100) calc((r - 163.8) / 0.35) calc((g - 163.8) / 0.35) calc((b - 163.15) / 0.35) / 35%);
  --bg-tint-magenta-opaque: var(--magenta-100);
  --bg-git-added: color-mix(in srgb, var(--text-git-added) 20%, transparent);
  --bg-git-removed: color-mix(in srgb, var(--text-git-removed) 20%, transparent);
  --bg-git-modified: color-mix(in srgb, var(--text-git-modified) 20%, transparent);
  --bg-git-merged: color-mix(in srgb, var(--text-git-merged) 20%, transparent);
  --bg-git-closed: color-mix(in srgb, var(--text-git-closed) 20%, transparent);
  --bg-git-conflicting: color-mix(in srgb, var(--text-git-conflicting) 20%, transparent);
  --bg-git-draft: color-mix(in srgb, var(--text-git-draft) 20%, transparent);
  --bg-git-opened: var(--bg-git-added);
  --bg-git-queued: var(--bg-git-modified);
  --bg-editor-canvas: var(--neutral-60);
  --bg-neutral: var(--alpha-1);
  --bg-neutral-hover: var(--alpha-2);
  --bg-user-message: var(--bg-neutral);
  --backdrop: rgb(0 0 0 / 0.4);
  --text-accent: var(--role-accent-600);
  --text-danger: var(--role-danger-600);
  --text-success: var(--role-success-600);
  --text-warning: var(--role-warning-600);
  --text-pro: var(--role-pro-600);
  --text-tint-red: var(--red-600);
  --text-tint-orange: var(--orange-600);
  --text-tint-yellow: var(--yellow-600);
  --text-tint-green: var(--green-600);
  --text-tint-aqua: var(--aqua-600);
  --text-tint-blue: var(--blue-600);
  --text-tint-violet: var(--violet-600);
  --text-tint-magenta: var(--magenta-600);
  --text-git-added: #1e9e3c;
  --text-git-removed: #cd2054;
  --text-git-modified: #98801f;
  --text-git-merged: #8e6bd9;
  --text-git-closed: #ff3a30;
  --text-git-conflicting: #c5621b;
  --text-git-draft: #737373;
  --text-git-opened: var(--text-git-added);
  --text-git-queued: var(--text-git-modified);
  --text-primary: var(--neutral-900);
  --text-secondary: var(--neutral-600);
  --text-muted: var(--neutral-400);
  --text-disabled: var(--alpha-4);
  --on-primary: var(--neutral-0);
  --on-git-added: var(--gray-0);
  --on-git-removed: var(--gray-0);
  --on-git-modified: var(--gray-0);
  --on-git-merged: var(--gray-0);
  --on-git-closed: var(--gray-0);
  --on-git-conflicting: var(--gray-0);
  --on-git-draft: var(--gray-0);
  --on-git-opened: var(--on-git-added);
  --on-git-queued: var(--on-git-modified);
  --chart-categorical-1: var(--blue-450);
  --chart-categorical-2: var(--orange-350);
  --chart-categorical-3: var(--aqua-350);
  --chart-categorical-4: var(--yellow-250);
  --chart-categorical-5: var(--magenta-300);
  --chart-categorical-6: var(--green-500);
  --chart-categorical-7: var(--violet-500);
  --chart-categorical-8: var(--red-400);
  --chart-sequential-1: var(--blue-100);
  --chart-sequential-2: var(--blue-200);
  --chart-sequential-3: var(--blue-300);
  --chart-sequential-4: var(--blue-400);
  --chart-sequential-5: var(--blue-500);
  --chart-sequential-6: var(--blue-600);
  --chart-sequential-7: var(--blue-700);
  --chart-diverging-1: var(--blue-500);
  --chart-diverging-2: var(--blue-350);
  --chart-diverging-3: var(--blue-200);
  --chart-diverging-4: var(--gray-50);
  --chart-diverging-5: var(--red-200);
  --chart-diverging-6: var(--red-350);
  --chart-diverging-7: var(--red-500);
  --chart-status-good: var(--green-400);
  --chart-status-warning: var(--yellow-200);
  --chart-status-serious: var(--orange-300);
  --chart-status-critical: var(--red-450);
  --chart-muted: var(--gray-200);
  --chart-reference: var(--gray-400);
  --chart-reference-tint: hsl(from var(--gray-400) h s l / 15%);
  --chart-grid: var(--alpha-2);
  --chart-axis: var(--gray-200);
  --chart-baseline: var(--gray-200);
}

@media screen {
  [data-mode="dark"] {
    --border-accent: var(--role-accent-700);
    --border-danger: var(--role-danger-700);
    --border-success: var(--role-success-700);
    --border-warning: var(--role-warning-700);
    --border-pro: var(--role-pro-700);
    --border-editor-comment: var(--yellow-300);
    --border-editor-comment-open: var(--yellow-200);
    --shadow-color: rgba(0, 0, 0, 0.24);
    --shadow-popover: 0 8px 24px rgb(0 0 0 / 0.32), 0 2px 6px rgb(0 0 0 / 0.2);
    --ring-outer: 0px;
    --ring-inner: 1px;
    --ring-color: var(--alpha-2);
    --focus-shadow: inset 0 0 0 1px var(--page-bg), 0 0 0 1px var(--fill-accent), 0 0 6px 1px hsl(from var(--role-accent-600) h s l / 60%);
    --focus-shadow-danger: inset 0 0 0 1px var(--page-bg), 0 0 0 1px var(--fill-danger), 0 0 6px 1px hsl(from var(--role-danger-600) h s l / 60%);
    --pictogram-highlight-default: var(--gray-650);
    --pictogram-highlight-heather: var(--plum);
    --pictogram-highlight-cactus: var(--mineral);
    --neutral-0: var(--gray-900);
    --neutral-10: var(--gray-890);
    --neutral-20: var(--gray-880);
    --neutral-30: var(--gray-870);
    --neutral-40: var(--gray-860);
    --neutral-50: var(--gray-850);
    --neutral-60: var(--gray-840);
    --neutral-70: var(--gray-830);
    --neutral-80: var(--gray-820);
    --neutral-90: var(--gray-810);
    --neutral-100: var(--gray-800);
    --neutral-150: var(--gray-750);
    --neutral-200: var(--gray-700);
    --neutral-250: var(--gray-650);
    --neutral-300: var(--gray-600);
    --neutral-350: var(--gray-550);
    --neutral-400: var(--gray-500);
    --neutral-450: var(--gray-450);
    --neutral-500: var(--gray-400);
    --neutral-550: var(--gray-350);
    --neutral-600: var(--gray-300);
    --neutral-650: var(--gray-250);
    --neutral-700: var(--gray-200);
    --neutral-750: var(--gray-150);
    --neutral-800: var(--gray-100);
    --neutral-810: var(--gray-90);
    --neutral-820: var(--gray-80);
    --neutral-830: var(--gray-70);
    --neutral-840: var(--gray-60);
    --neutral-850: var(--gray-50);
    --neutral-860: var(--gray-40);
    --neutral-870: var(--gray-30);
    --neutral-880: var(--gray-20);
    --neutral-890: var(--gray-10);
    --neutral-900: var(--gray-0);
    --surface-0: var(--gray-900);
    --surface-1: var(--gray-850);
    --surface-2: var(--gray-830);
    --surface-3: var(--gray-800);
    --fill-git-added: var(--text-git-added);
    --fill-git-added-hover: #27c840;
    --fill-git-removed-hover: #ff1342;
    --fill-git-modified: var(--text-git-modified);
    --fill-git-modified-hover: #fac800;
    --fill-git-merged: var(--text-git-merged);
    --fill-git-merged-hover: #a67dff;
    --fill-git-closed: var(--text-git-closed);
    --fill-git-closed-hover: #ff4940;
    --fill-git-conflicting: var(--text-git-conflicting);
    --fill-git-conflicting-hover: #f97a1f;
    --fill-git-draft-hover: #999999;
    --fill-primary-hover: var(--gray-100);
    --fill-secondary: var(--alpha-2);
    --fill-secondary-hover: hsl(from var(--neutral-900) h s l / 14%);
    --fill-secondary-ring: transparent;
    --fill-field: var(--alpha-1);
    --fill-ghost-hover: hsl(from var(--neutral-900) h s l / 7.5%);
    --fill-ghost-selected: hsl(from var(--neutral-900) h s l / 15%);
    --bg-accent: var(--role-accent-800);
    --bg-danger: var(--role-danger-800);
    --bg-success: var(--role-success-800);
    --bg-warning: var(--role-warning-800);
    --bg-pro: var(--role-pro-800);
    --bg-tint-red: rgb(from var(--red-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-red-opaque: var(--red-800);
    --bg-tint-orange: rgb(from var(--orange-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-orange-opaque: var(--orange-800);
    --bg-tint-yellow: rgb(from var(--yellow-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-yellow-opaque: var(--yellow-800);
    --bg-tint-green: rgb(from var(--green-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-green-opaque: var(--green-800);
    --bg-tint-aqua: rgb(from var(--aqua-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-aqua-opaque: var(--aqua-800);
    --bg-tint-blue: rgb(from var(--blue-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-blue-opaque: var(--blue-800);
    --bg-tint-violet: rgb(from var(--violet-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-violet-opaque: var(--violet-800);
    --bg-tint-magenta: rgb(from var(--magenta-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-magenta-opaque: var(--magenta-800);
    --backdrop: rgb(0 0 0 / 0.5);
    --text-accent: var(--role-accent-300);
    --text-danger: var(--role-danger-300);
    --text-success: var(--role-success-400);
    --text-warning: var(--role-warning-300);
    --text-pro: var(--role-pro-300);
    --text-tint-red: var(--red-300);
    --text-tint-orange: var(--orange-300);
    --text-tint-yellow: var(--yellow-300);
    --text-tint-green: var(--green-300);
    --text-tint-aqua: var(--aqua-300);
    --text-tint-blue: var(--blue-300);
    --text-tint-violet: var(--violet-300);
    --text-tint-magenta: var(--magenta-300);
    --text-git-added: #32d74b;
    --text-git-removed: #ff2c56;
    --text-git-modified: #ffd014;
    --text-git-merged: #b796ff;
    --text-git-closed: #ff6159;
    --text-git-conflicting: #fa832e;
    --text-git-draft: #a6a6a6;
    --text-primary: var(--gray-50);
    --text-secondary: var(--gray-200);
    --text-muted: var(--gray-400);
    --on-git-added: var(--gray-900);
    --on-git-removed: var(--gray-900);
    --on-git-modified: var(--gray-900);
    --on-git-merged: var(--gray-900);
    --on-git-closed: var(--gray-900);
    --on-git-conflicting: var(--gray-900);
    --on-git-draft: var(--gray-900);
    --chart-categorical-1: var(--blue-400);
    --chart-categorical-2: var(--orange-400);
    --chart-categorical-3: var(--aqua-400);
    --chart-categorical-4: var(--yellow-350);
    --chart-categorical-5: var(--magenta-400);
    --chart-categorical-6: var(--green-500);
    --chart-categorical-7: var(--violet-350);
    --chart-categorical-8: var(--red-350);
    --chart-sequential-1: var(--blue-700);
    --chart-sequential-2: var(--blue-600);
    --chart-sequential-3: var(--blue-500);
    --chart-sequential-4: var(--blue-400);
    --chart-sequential-5: var(--blue-300);
    --chart-sequential-6: var(--blue-200);
    --chart-sequential-7: var(--blue-100);
    --chart-diverging-1: var(--blue-300);
    --chart-diverging-2: var(--blue-450);
    --chart-diverging-3: var(--blue-600);
    --chart-diverging-4: var(--gray-700);
    --chart-diverging-5: var(--red-600);
    --chart-diverging-6: var(--red-450);
    --chart-diverging-7: var(--red-300);
    --chart-status-good: var(--green-400);
    --chart-status-warning: var(--yellow-200);
    --chart-status-serious: var(--orange-300);
    --chart-status-critical: var(--red-450);
    --chart-muted: var(--gray-550);
    --chart-reference: var(--gray-350);
    --chart-reference-tint: hsl(from var(--gray-350) h s l / 15%);
    --chart-axis: var(--gray-700);
    --chart-baseline: var(--gray-700);
  }
}

@media screen and (prefers-color-scheme: dark) {
  :root:where(:not([data-mode="light"])),
  [data-mode="system"] {
    --border-accent: var(--role-accent-700);
    --border-danger: var(--role-danger-700);
    --border-success: var(--role-success-700);
    --border-warning: var(--role-warning-700);
    --border-pro: var(--role-pro-700);
    --border-editor-comment: var(--yellow-300);
    --border-editor-comment-open: var(--yellow-200);
    --shadow-color: rgba(0, 0, 0, 0.24);
    --shadow-popover: 0 8px 24px rgb(0 0 0 / 0.32), 0 2px 6px rgb(0 0 0 / 0.2);
    --ring-outer: 0px;
    --ring-inner: 1px;
    --ring-color: var(--alpha-2);
    --focus-shadow: inset 0 0 0 1px var(--page-bg), 0 0 0 1px var(--fill-accent), 0 0 6px 1px hsl(from var(--role-accent-600) h s l / 60%);
    --focus-shadow-danger: inset 0 0 0 1px var(--page-bg), 0 0 0 1px var(--fill-danger), 0 0 6px 1px hsl(from var(--role-danger-600) h s l / 60%);
    --pictogram-highlight-default: var(--gray-650);
    --pictogram-highlight-heather: var(--plum);
    --pictogram-highlight-cactus: var(--mineral);
    --neutral-0: var(--gray-900);
    --neutral-10: var(--gray-890);
    --neutral-20: var(--gray-880);
    --neutral-30: var(--gray-870);
    --neutral-40: var(--gray-860);
    --neutral-50: var(--gray-850);
    --neutral-60: var(--gray-840);
    --neutral-70: var(--gray-830);
    --neutral-80: var(--gray-820);
    --neutral-90: var(--gray-810);
    --neutral-100: var(--gray-800);
    --neutral-150: var(--gray-750);
    --neutral-200: var(--gray-700);
    --neutral-250: var(--gray-650);
    --neutral-300: var(--gray-600);
    --neutral-350: var(--gray-550);
    --neutral-400: var(--gray-500);
    --neutral-450: var(--gray-450);
    --neutral-500: var(--gray-400);
    --neutral-550: var(--gray-350);
    --neutral-600: var(--gray-300);
    --neutral-650: var(--gray-250);
    --neutral-700: var(--gray-200);
    --neutral-750: var(--gray-150);
    --neutral-800: var(--gray-100);
    --neutral-810: var(--gray-90);
    --neutral-820: var(--gray-80);
    --neutral-830: var(--gray-70);
    --neutral-840: var(--gray-60);
    --neutral-850: var(--gray-50);
    --neutral-860: var(--gray-40);
    --neutral-870: var(--gray-30);
    --neutral-880: var(--gray-20);
    --neutral-890: var(--gray-10);
    --neutral-900: var(--gray-0);
    --surface-0: var(--gray-900);
    --surface-1: var(--gray-850);
    --surface-2: var(--gray-830);
    --surface-3: var(--gray-800);
    --fill-git-added: var(--text-git-added);
    --fill-git-added-hover: #27c840;
    --fill-git-removed-hover: #ff1342;
    --fill-git-modified: var(--text-git-modified);
    --fill-git-modified-hover: #fac800;
    --fill-git-merged: var(--text-git-merged);
    --fill-git-merged-hover: #a67dff;
    --fill-git-closed: var(--text-git-closed);
    --fill-git-closed-hover: #ff4940;
    --fill-git-conflicting: var(--text-git-conflicting);
    --fill-git-conflicting-hover: #f97a1f;
    --fill-git-draft-hover: #999999;
    --fill-primary-hover: var(--gray-100);
    --fill-secondary: var(--alpha-2);
    --fill-secondary-hover: hsl(from var(--neutral-900) h s l / 14%);
    --fill-secondary-ring: transparent;
    --fill-field: var(--alpha-1);
    --fill-ghost-hover: hsl(from var(--neutral-900) h s l / 7.5%);
    --fill-ghost-selected: hsl(from var(--neutral-900) h s l / 15%);
    --bg-accent: var(--role-accent-800);
    --bg-danger: var(--role-danger-800);
    --bg-success: var(--role-success-800);
    --bg-warning: var(--role-warning-800);
    --bg-pro: var(--role-pro-800);
    --bg-tint-red: rgb(from var(--red-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-red-opaque: var(--red-800);
    --bg-tint-orange: rgb(from var(--orange-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-orange-opaque: var(--orange-800);
    --bg-tint-yellow: rgb(from var(--yellow-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-yellow-opaque: var(--yellow-800);
    --bg-tint-green: rgb(from var(--green-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-green-opaque: var(--green-800);
    --bg-tint-aqua: rgb(from var(--aqua-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-aqua-opaque: var(--aqua-800);
    --bg-tint-blue: rgb(from var(--blue-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-blue-opaque: var(--blue-800);
    --bg-tint-violet: rgb(from var(--violet-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-violet-opaque: var(--violet-800);
    --bg-tint-magenta: rgb(from var(--magenta-800) calc((r - 5.25) / 0.75) calc((g - 5.25) / 0.75) calc((b - 5.25) / 0.75) / 75%);
    --bg-tint-magenta-opaque: var(--magenta-800);
    --backdrop: rgb(0 0 0 / 0.5);
    --text-accent: var(--role-accent-300);
    --text-danger: var(--role-danger-300);
    --text-success: var(--role-success-400);
    --text-warning: var(--role-warning-300);
    --text-pro: var(--role-pro-300);
    --text-tint-red: var(--red-300);
    --text-tint-orange: var(--orange-300);
    --text-tint-yellow: var(--yellow-300);
    --text-tint-green: var(--green-300);
    --text-tint-aqua: var(--aqua-300);
    --text-tint-blue: var(--blue-300);
    --text-tint-violet: var(--violet-300);
    --text-tint-magenta: var(--magenta-300);
    --text-git-added: #32d74b;
    --text-git-removed: #ff2c56;
    --text-git-modified: #ffd014;
    --text-git-merged: #b796ff;
    --text-git-closed: #ff6159;
    --text-git-conflicting: #fa832e;
    --text-git-draft: #a6a6a6;
    --text-primary: var(--gray-50);
    --text-secondary: var(--gray-200);
    --text-muted: var(--gray-400);
    --on-git-added: var(--gray-900);
    --on-git-removed: var(--gray-900);
    --on-git-modified: var(--gray-900);
    --on-git-merged: var(--gray-900);
    --on-git-closed: var(--gray-900);
    --on-git-conflicting: var(--gray-900);
    --on-git-draft: var(--gray-900);
    --chart-categorical-1: var(--blue-400);
    --chart-categorical-2: var(--orange-400);
    --chart-categorical-3: var(--aqua-400);
    --chart-categorical-4: var(--yellow-350);
    --chart-categorical-5: var(--magenta-400);
    --chart-categorical-6: var(--green-500);
    --chart-categorical-7: var(--violet-350);
    --chart-categorical-8: var(--red-350);
    --chart-sequential-1: var(--blue-700);
    --chart-sequential-2: var(--blue-600);
    --chart-sequential-3: var(--blue-500);
    --chart-sequential-4: var(--blue-400);
    --chart-sequential-5: var(--blue-300);
    --chart-sequential-6: var(--blue-200);
    --chart-sequential-7: var(--blue-100);
    --chart-diverging-1: var(--blue-300);
    --chart-diverging-2: var(--blue-450);
    --chart-diverging-3: var(--blue-600);
    --chart-diverging-4: var(--gray-700);
    --chart-diverging-5: var(--red-600);
    --chart-diverging-6: var(--red-450);
    --chart-diverging-7: var(--red-300);
    --chart-status-good: var(--green-400);
    --chart-status-warning: var(--yellow-200);
    --chart-status-serious: var(--orange-300);
    --chart-status-critical: var(--red-450);
    --chart-muted: var(--gray-550);
    --chart-reference: var(--gray-350);
    --chart-reference-tint: hsl(from var(--gray-350) h s l / 15%);
    --chart-axis: var(--gray-700);
    --chart-baseline: var(--gray-700);
  }
}

:root,
[data-platform="web"],
[data-platform="desktop"] {
  --cursor-interactive: pointer;
}

[data-platform="desktop"] {
  --cursor-interactive: default;
}

[data-mode="light"]:not(:root),
[data-mode="system"]:not(:root) {
  color-scheme: light;
}

@media screen {
  [data-mode="dark"]:not(:root) {
    color-scheme: dark;
  }
}

@media screen and (prefers-color-scheme: dark) {
  [data-mode="system"]:not(:root) {
    color-scheme: dark;
  }
}
</style>
  <style>:root {
  color-scheme: light dark;
  --font-serif: "anthropic-serif", Georgia, "Times New Roman", serif;
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
input,
select,
textarea,
button {
  font-family: inherit;
}
body {
  font-family:
    "anthropic-sans",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  background: transparent;
}
/* The host sizes the iframe a frame late, and a scrollbar shown meanwhile would take ~15px and reflow the visual, so it has no width.
 * A saved page (data-saved) is in no iframe and keeps its scrollbars. :where() adds no weight, so a visual's own rule still wins. */
html:where(:not([data-saved])),
:where(html:not([data-saved])) body {
  scrollbar-width: none;
}
html:where(:not([data-saved]))::-webkit-scrollbar,
:where(html:not([data-saved])) body::-webkit-scrollbar {
  width: 0;
  height: 0;
}
/* Short var aliases — saves ~5 tokens per reference */
:root {
  --p: var(--text-primary);
  --s: var(--text-secondary);
  --t: var(--text-muted);
  --bg2: var(--surface-1);
  --b: var(--border-strong);
}

/* SVG utility classes — use class="t" instead of repeating font/fill attrs */
.t {
  font-size: 14px;
  fill: var(--p);
}
.ts {
  font-size: 12px;
  fill: var(--s);
}
.th {
  font-size: 14px;
  fill: var(--p);
  font-weight: 500;
}
.box {
  fill: var(--bg2);
  stroke: var(--b);
}
.arr {
  stroke: var(--t);
  fill: none;
  stroke-width: 1.5;
}
.node {
  cursor: pointer;
}
.node:hover rect,
.node:hover .box {
  filter: brightness(0.97);
}
.node:hover text {
  opacity: 0.8;
}

/* Form element defaults — model writes bare <input>, styling is automatic */
/* :not(form.elicit *) — elicitation form provides its own
 * input/button styling at (0,1,0). Without this exclusion, these
 * generic rules at (0,3,1) / (1,0,2) clobber every .elicit-* class. */
input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not(
    form.elicit *
  ),
select:not(form.elicit *),
textarea:not(form.elicit *) {
  /* iOS zooms the page when a focused input's font size is under 16px. */
  --input-font-size: max(16px, var(--font-text-md-size, 16px));
  width: 100%;
  /* 36px tall at the default 16px font; a fixed height clips select text in larger fonts. */
  height: calc(var(--input-font-size) * 2.25);
  padding: 8px 12px;
  font-size: var(--input-font-size);
  background: var(--surface-2);
  color: var(--text-primary);
  border: 0.5px solid var(--border);
  border-radius: 6px;
  outline: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
textarea {
  height: auto;
  min-height: 80px;
  resize: vertical;
}
input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not(
    form.elicit *
  ):hover,
select:not(form.elicit *):hover,
textarea:not(form.elicit *):hover {
  border-color: var(--border-strong);
}
input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not(
    form.elicit *
  ):focus,
select:not(form.elicit *):focus,
textarea:not(form.elicit *):focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--bg-accent);
}
select {
  cursor: pointer;
}

/* Range slider — model writes bare <input type="range">, styling automatic */
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
  border-radius: 2px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  transition:
    border-color 0.15s,
    transform 0.15s;
}
input[type="range"]:hover::-webkit-slider-thumb {
  border-color: var(--border-stronger);
  transform: scale(1.1);
}
input[type="range"]::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  cursor: pointer;
}

/* Button defaults — model writes bare <button>, interaction states automatic */
button:not(
    #action-btns button,
    :where(#vis-container ~ #larger-btns) button
  ):not(form.elicit button) {
  padding: 8px 16px;
  font-size: var(--font-text-sm-size, 14px);
  background: transparent;
  color: var(--text-primary);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--radius);
  cursor: pointer;
  transition:
    background 0.15s,
    transform 0.1s;
}
button:not(
    #action-btns button,
    :where(#vis-container ~ #larger-btns) button
  ):not(form.elicit button):hover {
  background: var(--surface-1);
}
button:not(
    #action-btns button,
    :where(#vis-container ~ #larger-btns) button
  ):not(form.elicit button):active {
  background: var(--border);
  transform: scale(0.98);
}

/* ===== Elicitation form — EA-878 =====
 * Inert unless Claude writes <form class="elicit">.
 * Figma: AaGSDTRrOCNVhNa7LZaJVr node 5340:3930
 * Conversational question prompts ("Which side are you on?"),
 * pills for all choices.
 */

form.elicit {
  background: var(--surface-2);
  border: 0.5px solid var(--border);
  border-radius: 16px;
  /* Figma 5340:3930 — soft diffuse shadow, lighter than DS --shadow-md.
   * Margin keeps the shadow from clipping at #vis-container's overflow:hidden
   * edge: y-offset 4px + blur 20px ≈ 24px below, 20px sides. */
  box-shadow: 0 4px 20px 0 rgba(0, 0, 0, 0.04);
  margin: 4px 20px 24px;
  overflow: hidden;
  font-family: var(--font-sans);
  font-size: var(--font-text-sm-size, 14px);
  line-height: 1.4;
  /* Match host rendering — without this the iframe uses subpixel AA and
   * everything (notably weight-500 buttons) reads ~100 heavier on Retina
   * than the same tokens outside the iframe. */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  /* Chrome props animate on the form→submitted-summary swap. */
  transition:
    background-color 200ms ease-out,
    box-shadow 200ms ease-out,
    border-radius 200ms ease-out,
    padding 200ms ease-out,
    margin 200ms ease-out;
  /* Shared FileThumbnail tokens (border-border-300/25, shadow-sm/5). */
  --elicit-border-faint: color-mix(in srgb, var(--border) 25%, transparent);
  --elicit-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}
/* Form controls don't inherit font props from the UA sheet — pull from root.
 * `font: inherit` shorthand so font-weight comes too; the individual-prop
 * version left weight at the UA <button> default (bold-ish on some
 * platforms) for any control that doesn't set its own weight. */
form.elicit :is(button, input, textarea) {
  font: inherit;
}

/* Header title and question prompts share Claude's chat-output voice —
 * must track the p.font-claude-response-body composite (Anthropic Serif
 * 16 / 400 / 1.5) so both read as Claude speaking, not form chrome. */
form.elicit .elicit-header,
form.elicit .elicit-question {
  font-family: var(--font-voice);
  font-size: var(--font-text-md-size, 16px);
  font-weight: 400;
  line-height: 1.5;
  color: var(--text-primary);
}

/* 2.75 x its text (44px at the default 16px, suggested-connector spec), so one line always fits.
 * A set height with no vertical padding lets align-items:center place the icon and text. */
form.elicit .elicit-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(var(--font-text-md-size, 16px) * 2.75);
  padding: 0 16px;
  border-bottom: 0.5px solid var(--border);
}
form.elicit .elicit-header > svg {
  /* IconBase vectorSizeMap[16] = 20 — anthropicons render in a 20px box. */
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  fill: currentColor;
}
form.elicit .elicit-header > span {
  flex: 1;
}

form.elicit .elicit-body {
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  gap: 40px;
}

form.elicit .elicit-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

form.elicit .elicit-question {
  margin: 0;
}

/* Pills container — no horizontal padding. Previously had 0 8px which pushed
 * pills 8px right of the question/textarea/date in the same .elicit-group. */
form.elicit .elicit-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
form.elicit .elicit-pill {
  /* Fully rounded + tighter padding — visually distinct from the rectangular
   * text inputs (textarea/other/date stay at 8-12px radius). Pills and inputs
   * don't match in height so the shape difference reads as intentional. */
  padding: 8px 12px;
  border: 0.5px solid var(--border);
  border-radius: 9999px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}
form.elicit .elicit-pill:hover {
  border-color: var(--border-strong);
}
/* Semantic accents — same light-fill+soft-border recipe as the blue selected
 * state, applied via attribute so inline style doesn't fight aria-pressed.
 * Single-attr specificity; the [aria-pressed="true"] rule below wins on
 * border+bg so selection remains visible on accented pills. */
form.elicit .elicit-pill[data-accent="warning"] {
  border-color: var(--text-warning);
  background: color-mix(in srgb, var(--text-warning) 15%, transparent);
  color: var(--text-warning);
}
form.elicit .elicit-pill[data-accent="danger"] {
  border-color: var(--text-danger);
  background: color-mix(in srgb, var(--text-danger) 15%, transparent);
  color: var(--text-danger);
}
form.elicit .elicit-pill[data-accent="success"] {
  border-color: var(--text-success);
  background: color-mix(in srgb, var(--text-success) 15%, transparent);
  color: var(--text-success);
}
form.elicit .elicit-pill[aria-pressed="true"] {
  /* Figma: 0.5px #184f95 border + rgba(205,226,251,0.5) fill (approx via color-mix). */
  border: 0.5px solid var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 15%, transparent);
  /* accent text — matches border + fill. */
  color: var(--text-accent);
}

/* "Other" conditional text input.
 * background/color explicit — generic input rule no longer provides
 * these post-specificity-fix, UA Canvas/CanvasText mismatch in dark mode. */
form.elicit .elicit-other {
  margin-top: 8px;
  height: calc(var(--font-text-sm-size, 14px) * 40 / 14);
  padding: 0 12px;
  border: 0.5px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-primary);
  width: 100%;
  box-sizing: border-box;
}
form.elicit .elicit-other[hidden] {
  display: none;
}

/* Textarea.
 * background/color explicit — generic textarea rule no longer provides
 * these post-specificity-fix, UA Canvas/CanvasText mismatch in dark mode. */
form.elicit .elicit-textarea {
  min-height: 84px;
  padding: 12px;
  border: 0.5px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-primary);
  resize: vertical;
  box-sizing: border-box;
  width: 100%;
}
form.elicit .elicit-textarea::placeholder {
  color: var(--text-muted);
}

/* Date input — pill-shaped, hugs content */
form.elicit .elicit-date {
  padding: 12px 16px;
  border: 0.5px solid var(--border);
  border-radius: 12px;
  background: transparent;
  color: var(--text-primary);
  width: fit-content;
  cursor: pointer;
}
/* Shared focus ring for all text inputs — info-blue border + soft glow */
form.elicit .elicit-other:focus,
form.elicit .elicit-textarea:focus,
form.elicit .elicit-date:focus {
  outline: none;
  border-color: var(--border-accent);
  box-shadow: 0 0 0 3px var(--bg-accent);
}

/* File upload — dashed dropzone + filled tiles.
 * Tile styling mirrors packages/chat/components/FileThumbnail.tsx (the
 * thumbnail users already see in the chat input row) so a file picked here
 * reads as the same object it becomes once attached. Dropzone is the first
 * flex child; tiles append after it (flow right). */
form.elicit .elicit-files {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
}
form.elicit .elicit-dropzone {
  /* 120×120 = FileThumbnail SIZE_MAP.normal. Dashed stays 1px — 0.5px
   * dashed rasterizes to invisible gaps on non-retina. */
  width: 120px;
  height: 120px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  box-shadow: var(--elicit-shadow-sm);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  /* Figma 5340:4071 — 2% text-000 wash over bg-000 */
  background: color-mix(in srgb, var(--text-primary) 2%, var(--surface-2));
  color: var(--text-muted);
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}
form.elicit .elicit-dropzone:hover {
  border-color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 4%, transparent);
}
form.elicit .elicit-dropzone svg {
  width: 24px;
  height: 24px;
  fill: currentColor;
}
form.elicit .elicit-dropzone input[type="file"] {
  display: none;
}

form.elicit .elicit-file-tile {
  /* FileThumbnail ThumbnailInteractionContainer:
   * rounded-lg border-0.5 border-border-300/25 shadow-sm shadow-always-black/5
   * bg-bg-000 px-2.5 py-2 gap-2.5 → 8px radius, 0.5px border, 8/10px pad */
  width: 120px;
  height: 120px;
  border: 0.5px solid var(--elicit-border-faint);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  background: var(--surface-2);
  box-shadow: var(--elicit-shadow-sm);
  box-sizing: border-box;
  position: relative;
}
form.elicit .elicit-file-tile .name {
  /* FileThumbnail title: text-[12px] text-text-100 break-words line-clamp-3 */
  font-size: var(--font-text-xs-size, 12px);
  color: var(--text-primary);
  word-break: break-word;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
form.elicit .elicit-file-tile .badge {
  /* FileThumbnail ThumbnailTagContainer:
   * h-[18px] px-1 border-0.5 border-border-300/25 shadow-sm rounded
   * bg-bg-000/70 font-medium + inner text-[9px] uppercase font-bold */
  align-self: flex-start;
  height: calc(var(--font-text-xs-size, 12px) * 1.5);
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  border: 0.5px solid var(--elicit-border-faint);
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  box-shadow: var(--elicit-shadow-sm);
  font-size: calc(var(--font-text-xs-size, 12px) * 0.75);
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
}
/* FileThumbnail RemoveButton: w-5 h-5 -top-2 -left-2 rounded-full
 * border-0.5 border-border-300/25 bg-bg-000/90 backdrop-blur-sm.
 * Always visible (no group-hover in iframe — touch + no Tailwind group). */
form.elicit .elicit-file-tile .remove {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0.5px solid var(--elicit-border-faint);
  border-radius: 9999px;
  background: color-mix(in srgb, var(--surface-2) 90%, transparent);
  backdrop-filter: blur(4px);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    color 120ms ease,
    background-color 120ms ease;
}
form.elicit .elicit-file-tile .remove:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--surface-2) 50%, transparent);
}

/* Footer — DS Button tokens transcribed (variant=secondary / variant=primary,
 * size=default: h-9 px-4 rounded-lg min-w-[5rem] font-base-bold). */
form.elicit .elicit-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  /* A definite height (like .elicit-header) so the submitted-state height:0 transition can
   * interpolate (auto→0 snaps). At the default size: 36px buttons + 32px of room. */
  height: calc(var(--font-text-sm-size, 14px) * 68 / 14);
  padding: 0 24px;
  border-top: 0.5px solid var(--border);
}
form.elicit .elicit-skip,
form.elicit .elicit-submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: calc(var(--font-text-sm-size, 14px) * 36 / 14);
  /* min-width is fixed: wider buttons push Skip off a phone-width form */
  min-width: 80px;
  padding: 0 16px;
  border-radius: 8px;
  /* DS Button primary/secondary = font-base-bold (tw-typography.js:26) */
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition:
    background-color 100ms ease-out,
    border-color 100ms ease-out,
    transform 150ms cubic-bezier(0.165, 0.85, 0.45, 1);
}
form.elicit .elicit-skip:active,
form.elicit .elicit-submit:active {
  transform: scale(0.96);
}
/* secondary */
form.elicit .elicit-skip {
  border: 0.5px solid color-mix(in srgb, var(--border-strong) 30%, transparent);
  background: transparent;
  color: var(--text-primary);
}
form.elicit .elicit-skip:hover {
  background: var(--surface-1);
  border-color: transparent;
}
/* primary */
form.elicit .elicit-submit {
  border: none;
  background: var(--text-primary);
  color: var(--surface-2);
}
form.elicit .elicit-submit:hover {
  transform: scaleX(1.005) scaleY(1.015);
}
/* :hover and :active are both true during a mouse click; equal specificity →
 * source order wins, so without this the hover-grow above masks the press-down. */
form.elicit .elicit-submit:hover:active {
  transform: scale(0.96);
}

/* Post-submit — submitElicitation() adds .elicit-transitioning (body fades
 * out), then after 150ms swaps the body for the Q/A summary and adds
 * .elicit-submitted (chrome transitions to the bare card while body fades
 * back in). Mirrors AskUserQuestion: outer card = AskUserQuestionToolUseCell
 * .tsx:177 (rounded-xl border-0.5 border-border-300 p-4, no bg-bg-000 when
 * submitted), rows = SubmittedResponses.tsx:14-36. */
form.elicit .elicit-body {
  transition: opacity 150ms ease-out;
}
form.elicit.elicit-transitioning .elicit-body {
  opacity: 0;
}
form.elicit.elicit-submitted {
  background: transparent;
  border-radius: 12px;
  box-shadow: none;
  padding: 16px;
  margin: 4px;
}
/* `display: none` can't transition — collapse to zero so the chrome animates
 * away with the form's 200ms transition instead of snapping. */
form.elicit .elicit-header,
form.elicit .elicit-footer {
  transition:
    opacity 200ms ease-out,
    height 200ms ease-out,
    padding 200ms ease-out,
    border-width 200ms ease-out,
    /* step to hidden after the collapse so Skip/Submit leave the tab order +
     * a11y tree (pointer-events:none alone doesn't). */
    visibility 0s linear 200ms;
}
form.elicit.elicit-submitted .elicit-header,
form.elicit.elicit-submitted .elicit-footer {
  opacity: 0;
  height: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-width: 0;
  overflow: hidden;
  pointer-events: none;
  visibility: hidden;
}
form.elicit.elicit-submitted .elicit-body {
  padding: 0;
}
/* Quota-fallback "1" sentinel restore: shape check skips renderSubmittedSummary
 * so the body still has live inputs — dim them so the locked state reads. */
form.elicit.elicit-submitted .elicit-body:not(:has(.elicit-summary)) {
  pointer-events: none;
  opacity: 0.5;
}
/* sessionStorage restore path adds this alongside .elicit-submitted so
 * scroll-back/reload shows the summary immediately (no replayed crossfade). */
form.elicit.elicit-restored,
form.elicit.elicit-restored .elicit-body,
form.elicit.elicit-restored .elicit-header,
form.elicit.elicit-restored .elicit-footer {
  transition: none;
}
form.elicit .elicit-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
form.elicit .elicit-summary-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* SubmittedResponses question: text-text-300 font-claude-response-small-bold
 * (serif 14 / 600 / 1.5) */
form.elicit .elicit-summary-q {
  font-family: var(--font-voice);
  font-size: var(--font-text-sm-size, 14px);
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-secondary);
}
/* SubmittedResponses answer: text-text-500 font-base (sans 14 / 430 / 1.4) */
form.elicit .elicit-summary-a {
  font-weight: 430;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Headings — bare tags get correct color in both modes */
h1,
h2,
h3,
h4,
h5,
h6 {
  color: var(--text-primary);
}

.leader {
  stroke: var(--t);
  stroke-width: 0.5;
  stroke-dasharray: 4 3;
  fill: none;
}

/* Color ramp classes — apply to <g> or shape element (rect/ellipse/circle/polygon), never <path>.
   light-dark() responds to ancestor color-scheme, not just OS preference. */
g.c-purple > rect,
g.c-purple > ellipse,
g.c-purple > circle,
g.c-purple > polygon,
rect.c-purple,
ellipse.c-purple,
circle.c-purple,
polygon.c-purple {
  fill: light-dark(#eeedfe, #3c3489);
  stroke: light-dark(#534ab7, #afa9ec);
}
.c-purple > .th,
.c-purple > .t {
  fill: light-dark(#3c3489, #cecbf6);
}
.c-purple > .ts {
  fill: light-dark(#534ab7, #afa9ec);
}
g.c-teal > rect,
g.c-teal > ellipse,
g.c-teal > circle,
g.c-teal > polygon,
rect.c-teal,
ellipse.c-teal,
circle.c-teal,
polygon.c-teal {
  fill: light-dark(#e1f5ee, #085041);
  stroke: light-dark(#0f6e56, #5dcaa5);
}
.c-teal > .th,
.c-teal > .t {
  fill: light-dark(#085041, #9fe1cb);
}
.c-teal > .ts {
  fill: light-dark(#0f6e56, #5dcaa5);
}
g.c-coral > rect,
g.c-coral > ellipse,
g.c-coral > circle,
g.c-coral > polygon,
rect.c-coral,
ellipse.c-coral,
circle.c-coral,
polygon.c-coral {
  fill: light-dark(#faece7, #712b13);
  stroke: light-dark(#993c1d, #f0997b);
}
.c-coral > .th,
.c-coral > .t {
  fill: light-dark(#712b13, #f5c4b3);
}
.c-coral > .ts {
  fill: light-dark(#993c1d, #f0997b);
}
g.c-pink > rect,
g.c-pink > ellipse,
g.c-pink > circle,
g.c-pink > polygon,
rect.c-pink,
ellipse.c-pink,
circle.c-pink,
polygon.c-pink {
  fill: light-dark(#fbeaf0, #72243e);
  stroke: light-dark(#993556, #ed93b1);
}
.c-pink > .th,
.c-pink > .t {
  fill: light-dark(#72243e, #f4c0d1);
}
.c-pink > .ts {
  fill: light-dark(#993556, #ed93b1);
}
g.c-gray > rect,
g.c-gray > ellipse,
g.c-gray > circle,
g.c-gray > polygon,
rect.c-gray,
ellipse.c-gray,
circle.c-gray,
polygon.c-gray {
  fill: light-dark(#f1efe8, #444441);
  stroke: light-dark(#5f5e5a, #b4b2a9);
}
.c-gray > .th,
.c-gray > .t {
  fill: light-dark(#444441, #d3d1c7);
}
.c-gray > .ts {
  fill: light-dark(#5f5e5a, #b4b2a9);
}
g.c-blue > rect,
g.c-blue > ellipse,
g.c-blue > circle,
g.c-blue > polygon,
rect.c-blue,
ellipse.c-blue,
circle.c-blue,
polygon.c-blue {
  fill: light-dark(#e6f1fb, #0c447c);
  stroke: light-dark(#185fa5, #85b7eb);
}
.c-blue > .th,
.c-blue > .t {
  fill: light-dark(#0c447c, #b5d4f4);
}
.c-blue > .ts {
  fill: light-dark(#185fa5, #85b7eb);
}
g.c-green > rect,
g.c-green > ellipse,
g.c-green > circle,
g.c-green > polygon,
rect.c-green,
ellipse.c-green,
circle.c-green,
polygon.c-green {
  fill: light-dark(#eaf3de, #27500a);
  stroke: light-dark(#3b6d11, #97c459);
}
.c-green > .th,
.c-green > .t {
  fill: light-dark(#27500a, #c0dd97);
}
.c-green > .ts {
  fill: light-dark(#3b6d11, #97c459);
}
g.c-amber > rect,
g.c-amber > ellipse,
g.c-amber > circle,
g.c-amber > polygon,
rect.c-amber,
ellipse.c-amber,
circle.c-amber,
polygon.c-amber {
  fill: light-dark(#faeeda, #633806);
  stroke: light-dark(#854f0b, #ef9f27);
}
.c-amber > .th,
.c-amber > .t {
  fill: light-dark(#633806, #fac775);
}
.c-amber > .ts {
  fill: light-dark(#854f0b, #ef9f27);
}
g.c-red > rect,
g.c-red > ellipse,
g.c-red > circle,
g.c-red > polygon,
rect.c-red,
ellipse.c-red,
circle.c-red,
polygon.c-red {
  fill: light-dark(#fcebeb, #791f1f);
  stroke: light-dark(#a32d2d, #f09595);
}
.c-red > .th,
.c-red > .t {
  fill: light-dark(#791f1f, #f7c1c1);
}
.c-red > .ts {
  fill: light-dark(#a32d2d, #f09595);
}

/* Mermaid class/ER diagrams — match house aesthetic.
   Mermaid v11 class/ER renderers use <path> (not <rect>) with inline stroke/fill
   attrs that IGNORE themeVariables mainBkg/nodeBorder. Labels are
   <foreignObject><div><span class="nodeLabel"><p>text</p> — NOT <text>. All style
   fixes require !important to beat inline attrs + mermaid's inline <style>.
   Selectors target .classDiagram/.erDiagram SVG root classes (always present)
   rather than a .mermaid wrapper (which the model sometimes omits). */
svg.classDiagram,
svg.erDiagram {
  font-size: 13px;
  max-width: 100%;
  height: auto;
}
/* Mermaid sizes foreignObject to fit measured text width. If we upsize post-render,
   text clips. So: overflow visible on FO, and widen inner div past its max-width. */
svg.classDiagram foreignObject,
svg.erDiagram foreignObject {
  overflow: visible;
}
svg.classDiagram foreignObject > div,
svg.erDiagram foreignObject > div {
  max-width: none !important;
}
/* Body text: members, methods, attribute rows */
svg.classDiagram .nodeLabel,
svg.erDiagram .nodeLabel,
svg.classDiagram .label foreignObject div,
svg.erDiagram .label foreignObject div {
  font-family: var(--font-sans) !important;
  font-size: 13px !important;
  font-weight: 400 !important;
  color: var(--text-secondary) !important;
}
/* Titles: classDiagram wraps in .label-group; erDiagram wraps in .name */
svg.classDiagram .label-group .nodeLabel,
svg.erDiagram .name .nodeLabel {
  font-size: 14px !important;
  font-weight: 500 !important;
  color: var(--text-primary) !important;
}
/* Kill mermaid's inline style="font-weight: bolder" on the .label wrapper */
svg.classDiagram .label-group .label {
  font-weight: 500 !important;
}
/* Edge labels (relationship verbs + cardinality) */
svg.classDiagram .edgeLabel,
svg.classDiagram .edgeLabel span,
svg.classDiagram .edgeTerminals foreignObject div,
svg.erDiagram .edgeLabel,
svg.erDiagram .edgeLabel span {
  font-size: 11px !important;
  color: var(--text-muted) !important;
}
/* Box outlines, row stripes, dividers — all rendered as <path> with inline attrs.
   Mermaid's '#id .node path { fill:... }' CSS beats fill="none" attr — force fill:none. */
svg.classDiagram .node path[stroke]:not([stroke="none"]),
svg.classDiagram .divider path,
svg.erDiagram .node path[stroke]:not([stroke="none"]),
svg.erDiagram .divider path {
  stroke: var(--border) !important;
  stroke-width: 0.5px !important;
  fill: none !important;
}
/* classDiagram: box fill (inside .basic.label-container). Mermaid's inline CSS
   '#id .node path { stroke:... }' beats the stroke="none" attr (SVG attrs have
   lowest specificity), and the fill path is open (no Z) so the phantom stroke
   only paints top/right/bottom — left edge looks darker. Kill the stroke. */
svg.classDiagram .node .basic path[fill]:not([fill="none"]) {
  fill: var(--surface-2) !important;
  stroke: none !important;
  stroke-width: 0 !important;
}
/* erDiagram: header row (anonymous first-child <g>) uses secondary bg */
svg.erDiagram .node > g:first-child > path[fill]:not([fill="none"]) {
  fill: var(--surface-1) !important;
}
/* erDiagram: row stripes */
svg.erDiagram .row-rect-odd path[fill]:not([fill="none"]) {
  fill: var(--surface-2) !important;
}
svg.erDiagram .row-rect-even path[fill]:not([fill="none"]) {
  fill: var(--surface-1) !important;
}
/* Connector lines */
svg.erDiagram .relationshipLine,
svg.classDiagram .relation {
  stroke: var(--text-muted) !important;
  stroke-width: 1px !important;
}
svg.classDiagram .marker,
svg.classDiagram marker path,
svg.erDiagram .marker,
svg.erDiagram marker path {
  stroke: var(--text-muted) !important;
  stroke-width: 1px !important;
}
svg.classDiagram marker path[fill]:not([fill="none"]):not([fill="transparent"]),
svg.erDiagram marker path[fill]:not([fill="none"]):not([fill="transparent"]) {
  fill: var(--text-muted) !important;
}
/* Relationship label background — kill default 0.7 opacity */
svg.classDiagram .labelBkg,
svg.erDiagram .labelBkg {
  background-color: var(--surface-2) !important;
  opacity: 1 !important;
}

body {
  position: relative;
}
#vis-container {
  width: 100%;
  position: relative;
  overflow: hidden;
  /* Theme-aware default so text the model writes without an explicit
   * `color:` reads correctly when `data-mode` (app theme) diverges from
   * the browser's prefers-color-scheme — otherwise uncolored labels
   * inherit the UA default (black) over a dark surface. */
  color: var(--text-primary);
}
/* Registered so the values set on #vis-container stay on it, not inherited by every element of the visual. */
@property --wide-fade-left {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
@property --wide-fade-right {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
/* A visual laid out wider than the frame scrolls sideways (wide-scroll.ts). Each side with hidden content fades, except
   in a copy's picture, in View larger, and under keyboard focus, so the ring drawn inside shows. */
:root:not([data-open-larger]) #vis-container.scrolls-wide:not(.whole-width) {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  /* wide-scroll.ts's FADE_PX, so focusing an element inside scrolls it clear of the fade */
  scroll-padding-inline: 32px;
  /* No scrollbar row, as on html and body (base.css): a row would add to the height the frame is sized to. */
  scrollbar-width: none;
}
#vis-container.scrolls-wide::-webkit-scrollbar {
  height: 0;
}
:root:not([data-open-larger]) #vis-container.scrolls-wide:focus-visible {
  outline-offset: -2px;
}
:root:not([data-open-larger]):not([data-picture])
  #vis-container.scrolls-wide:not(.whole-width):not(
    :focus-visible
  )[data-wide-more] {
  -webkit-mask-image: linear-gradient(
    to right,
    transparent,
    #000 var(--wide-fade-left),
    #000 calc(100% - var(--wide-fade-right)),
    transparent
  );
  mask-image: linear-gradient(
    to right,
    transparent,
    #000 var(--wide-fade-left),
    #000 calc(100% - var(--wide-fade-right)),
    transparent
  );
}
/* While a copy is made of a drawing wider than the frame (clipboard-copy.ts): the clip above and below stays. A block
   container also takes flow-root, which keeps margins and floats inside as the clip did, so nothing on the page moves. */
#vis-container.whole-width {
  overflow-x: visible;
  overflow-y: clip;
}
#vis-container.whole-width-block {
  display: flow-root;
}
/* A visual can make <body> a grid or flex box, which grows the container to fit the drawing unless overflow is hidden,
   and clip is not. Zero minimums do what hidden did. :where() lets a minimum the visual sets outside @layer win. */
:where(#vis-container.whole-width) {
  min-width: 0;
  min-height: 0;
}
#vis-container > svg {
  display: block;
  margin-inline: auto;
  max-width: 100%;
  height: auto;
  overflow: visible;
}
/* host-init.ts sets data-center-content when the host asks. Only a lone top-level div moves, so
   stacked bars or bubbles keep their edges; :where() lets a side margin the visual sets win. */
:where(:root[data-center-content] #vis-container) > div:where(:only-of-type) {
  margin-inline: auto;
}

/* Action buttons group.
   hidden attr is removed on tool-input (final) so buttons never show during streaming. */
#action-btns {
  position: absolute;
  /* Centred in an iframe too short for 8px above and below the 28px trigger. */
  top: min(8px, (100vh - 28px) / 2);
  right: 8px;
  z-index: 2147483647;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}
/* display:flex above would override UA [hidden] — restore it */
#action-btns[hidden] {
  display: none;
}
body:hover #action-btns,
#action-btns[data-hold-open] {
  opacity: 1;
}
/* Hide on touch-primary (mobile) devices — both the reveal above
   (body:hover) and the popover open (#more-btn:hover) are hover-driven,
   so on a device without hover the ⋯ trigger either never appears or
   sticks visible after a stray tap with no way to open the menu. */
@media (hover: none) and (pointer: coarse) {
  #action-btns {
    display: none;
  }
}
/* Hidden after a press in the visual (menu-room.ts): unseen and click-through, but still in the tab order and read by
   screen readers. Not while Copy as image holds the menu open (data-hold-open) or the button or its menu has focus. */
:root[data-keep-menu-clear]
  #action-btns[data-quiet]:not([data-hold-open]):not(:focus-within) {
  opacity: 0;
  pointer-events: none;
}
/* Room for the button where text or a control of the visual would be under it (menu-room.ts). On <body>, which positions
   the button, so the visual moves and the button stays; !important beats the visual's own body padding, which --menu-room holds. */
:root[data-keep-menu-clear][data-menu-room]:not([data-open-larger]) body {
  padding-top: var(--menu-room) !important;
}
/* Once that room is taken away, the body stays at least as tall as it was (menu-room.ts's stopFollowingFrame). */
:root[data-keep-menu-clear][data-menu-held]:not([data-open-larger]) body {
  min-height: var(--menu-held) !important;
}
/* The body stays at least the height frame-sized.ts holds it at, so a visual sized by the frame's height has a frame to
   fill. View larger sizes the body itself. */
:root[data-frame-held]:not([data-open-larger]) body {
  min-height: var(--frame-held) !important;
}
/* Set by frame-sized.ts when a visual taller than the frame grows with it. */
:root[data-frame-capped]:not([data-open-larger]) body {
  max-height: var(--frame-cap) !important;
  overflow: hidden !important;
}
/* Set by frame-sized.ts after it lets go of an empty visual, until the frame settles. */
:root[data-frame-empty]:not([data-open-larger]) body {
  height: var(--frame-empty) !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
/* The View larger button and its full-screen view (open-larger.ts). It stands apart from #action-btns, which opens on
   hover and is removed on touch screens. "#vis-container ~" keeps these rules off a visual's own element with the same id. */
#vis-container ~ #larger-btns {
  /* Reset, as for #not-sent, so that a visual's own div or body rules (padding, a flex gap, an !important display) give
     this empty wrapper no room. */
  all: revert;
  display: contents !important;
}
/* display: contents keeps the wrapper's own ::before and ::after, which a visual's div::after rule would fill. */
#vis-container ~ #larger-btns::before,
#vis-container ~ #larger-btns::after {
  content: none !important;
}
/* The controls' positions are !important, here and for #larger-open, #larger-zoom and #larger-zoom-status below, so
   that a visual's own "position: ... !important" on a button, div or span cannot override them. */
#vis-container ~ #larger-btns button {
  position: relative !important;
  width: 36px;
  height: 36px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--surface-1);
  border: 0.5px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
}
/* The View larger button looks 36px and takes a tap within 44px. */
#vis-container ~ #larger-btns button::before {
  content: "";
  position: absolute;
  inset: -4px;
}
#vis-container ~ #larger-btns button[aria-disabled="true"] {
  opacity: 0.4;
  cursor: default;
}
#vis-container ~ #larger-btns #larger-open {
  position: absolute !important;
  top: 8px;
  top: min(8px, (100vh - 36px) / 2);
  right: 8px;
  z-index: 2147483646;
}
/* With data-resting on a touch screen the button is invisible and taps pass through it (open-larger.ts toggles it). It
   uses opacity, not display: none, so screen readers still find it and keyboard focus still reaches it and shows it. */
@media (hover: none) {
  #vis-container ~ #larger-btns #larger-open[data-resting]:not(:focus-visible) {
    opacity: 0;
    pointer-events: none;
  }
  #vis-container ~ #larger-btns #larger-open[data-arming] {
    pointer-events: none;
  }
}
#vis-container ~ #larger-btns #larger-open {
  transition: opacity 0.2s ease;
}
/* Important, so that a visual's own "button { display: flex !important }" cannot show a hidden one. */
#vis-container ~ #larger-btns #larger-open[hidden],
#vis-container ~ #larger-btns #larger-zoom[hidden] {
  display: none !important;
}
/* With a mouse, trackpad or hover, where #action-btns shows, the button sits to its left. */
@media (hover: hover), (pointer: fine) {
  #vis-container ~ #larger-btns #larger-open {
    right: 40px;
  }
}
/* In full screen the body is the frame's height and scrolls, so the size sent to the host does not grow. The padding keeps
   the visual clear of the host's bars, and the grid below undoes a visual's own flex or grid body, which would squeeze it. */
:root[data-open-larger] {
  overflow: hidden;
  /* With the body's own resets below, these undo a visual's html or body rules (a margin, padding, border, position,
     offset, sizing, minimum height or width) that would move the body, and the visual, out of the frame. */
  margin: 0;
  padding: 0;
  border: 0;
  inset: auto;
  width: auto;
  min-width: 0;
  max-width: none;
  --larger-button-size: 44px;
}
/* The right padding is room to pan the visual out from under the plus and minus pill; the left and top also take the
   centring offset. A grid without a visual's own grid rules: WebKit leaves a block's end padding out of its scroll. */
:root[data-open-larger] body {
  display: grid;
  position: relative;
  float: none;
  margin: 0;
  border: 0;
  inset: auto;
  box-sizing: border-box;
  min-height: 0;
  width: auto;
  min-width: 0;
  max-width: none;
  grid: none;
  gap: 0;
  place-items: start;
  justify-content: start;
  align-content: start;
  height: 100vh;
  overflow: auto;
  overscroll-behavior: contain;
  padding: calc(var(--host-inset-top, 0px) + 12px + var(--larger-lead-y, 0px))
    calc(
      var(--host-inset-right, 0px) + 12px + var(--larger-button-size) + 2px +
        12px
    )
    calc(var(--host-inset-bottom, 0px) + 12px)
    calc(var(--host-inset-left, 0px) + 12px + var(--larger-lead-x, 0px));
}
/* Zoomed in on a visual taller than the view: room above for the pill (two buttons and its 1px border top and bottom)
   and a gap, so its top can be pulled down clear of the pill (open-larger.ts). */
:root[data-open-larger][data-zoomed-in] body {
  padding-top: calc(
    var(--host-inset-top, 0px) + 12px + 2 * var(--larger-button-size) + 2px +
      12px + var(--larger-lead-y, 0px)
  );
}
/* A pinch is left to open-larger.ts, and one finger still pans natively. */
:root[data-open-larger] body {
  touch-action: pan-x pan-y;
}
:root[data-open-larger] #vis-container {
  overflow: visible;
}
/* Hidden in full screen: Copy as image sizes its picture from the body, which there is only one screen tall. */
:root[data-open-larger] #action-btns {
  display: none;
}
/* Pinned, or its place under the visual would add to the body's scroll height. */
#vis-container ~ #larger-btns #larger-zoom-status {
  position: absolute !important;
  top: 0;
  left: 0;
}
/* Top right, because both apps put their Close at the top left. */
#vis-container ~ #larger-btns #larger-zoom {
  position: fixed !important;
  margin: 0;
  top: calc(var(--host-inset-top, 0px) + 12px);
  right: calc(var(--host-inset-right, 0px) + 12px);
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  background: var(--surface-1);
  border: 1px solid var(--alpha-5);
  box-shadow: 0 1px 3px var(--alpha-2);
}
#vis-container ~ #larger-btns #larger-zoom button {
  width: var(--larger-button-size);
  height: var(--larger-button-size);
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
}
/* These are already 44px, so they need no wider tap area; the focus ring is drawn inside the pill, which clips. */
#vis-container ~ #larger-btns #larger-zoom button::before {
  content: none;
}
#vis-container ~ #larger-btns #larger-zoom button:focus-visible {
  outline-offset: -2px;
}
#vis-container ~ #larger-btns #larger-zoom button + button {
  border-top: 1px solid var(--alpha-3);
}
/* At the least or most zoom only the sign fades, not the line between the two buttons. */
#vis-container ~ #larger-btns #larger-zoom button[aria-disabled="true"] {
  opacity: 1;
}
#vis-container ~ #larger-btns #larger-zoom button[aria-disabled="true"] svg {
  opacity: 0.45;
}
/* 28×28 chip style for the ⋯ trigger.
   bg-100 at rest (visible over widget content), bg-300 on hover.
   No border — bg change is enough hover feedback. Transparent border stays
   for layout stability. */
#action-btns > button {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--surface-1);
  border: 1px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s ease;
}
#action-btns > button:hover {
  background: var(--surface-0);
}
/* With data-keep-menu-clear (set by host-init.ts), a smaller, fainter ⋯ nearer the corner. menu-room.ts sizes the room
   it adds from this box. */
:root[data-keep-menu-clear] #action-btns {
  /* Centred in an iframe too short for 4px above and below the 22px trigger. */
  top: min(4px, (100vh - 22px) / 2);
  right: 4px;
}
:root[data-keep-menu-clear] #action-btns > button {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: transparent;
  opacity: 0.7;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}
/* Lit while the pointer is on the button or its open menu, while Copy as image holds the menu open, and on keyboard
   focus, though the group itself shows only while the pointer is over the visual. */
:root[data-keep-menu-clear] #action-btns:hover > #more-btn,
:root[data-keep-menu-clear] #action-btns[data-hold-open] > #more-btn,
:root[data-keep-menu-clear] #action-btns > #more-btn:focus-visible {
  background: var(--surface-0);
  opacity: 1;
}
/* With no fill behind it, a halo in the page's colour keeps the dots readable over a dark or coloured corner. It can't be
   seen over the page itself. */
:root[data-keep-menu-clear] #action-btns > button > svg {
  width: 16px;
  height: 16px;
  filter: drop-shadow(0 0 1px var(--surface-0));
}
/* Popover — drops down-left from the trigger.
   Styled to match the native claude.ai Radix dropdown: white bg, backdrop
   blur, 0.5px border, subtle shadow. Items are single-line icon + label,
   matching the conversation menu (Star/Rename/Add to project). */
#more-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 8rem;
  padding: 6px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 0.5px solid var(--border-strong);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  box-shadow: 0 2px 8px light-dark(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.24));
  font-family: var(--font-sans);
  color: var(--text-secondary);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    visibility 0s linear 0.15s;
}
/* Reveal while hovering the ⋯ trigger or the popover, or while the script
   sets data-hold-open. A 4px dead-zone between trigger and popover would
   close it, so #more-popover:hover keeps it open during the crossing. */
#more-btn:hover ~ #more-popover,
#more-popover:hover,
#action-btns[data-hold-open] #more-popover {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
  transition:
    opacity 0.15s ease,
    transform 0.15s ease,
    visibility 0s;
}
/* Popover items — single-line icon + label, matching native dropdown menu */
.more-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-sans) !important;
  color: inherit;
  transition: background 0.1s ease;
  white-space: nowrap;
}
/* display:flex above would override UA [hidden] — restore it (same
   footgun as #action-btns[hidden]); the PNG item ships hidden until an
   SVG render completes. */
.more-item[hidden] {
  display: none;
}
.more-item:hover {
  background: var(--surface-1);
  color: var(--text-primary);
}
.more-item-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.more-item-icon svg {
  width: 20px;
  height: 20px;
}
.more-item-label {
  font-family: var(--font-sans) !important;
  font-size: var(--font-text-sm-size, 14px);
  line-height: 1.3;
  white-space: nowrap;
}
/* The row more-menu.ts picks for a short visual. 48px is the 28px trigger, its 4px gap and 8px
   at each side of the iframe, so labels shorten before the row can pass the left edge. */
#action-btns[data-beside] #more-popover {
  top: 50%;
  right: calc(100% + 4px);
  translate: 0 -50%;
  display: flex;
  min-width: 0;
  max-width: calc(100vw - 48px);
  padding: 0;
  border-radius: 8px;
}
/* With data-keep-menu-clear: the 22px trigger, its 4px gap and 4px at each side. */
:root[data-keep-menu-clear] #action-btns[data-beside] #more-popover {
  max-width: calc(100vw - 34px);
}
#action-btns[data-beside] .more-item {
  width: auto;
  min-width: 0;
  padding: 3px 8px;
  gap: 6px;
}
#action-btns[data-beside] .more-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The copy item gives way first, down to its icon and padding: the download labels differ only in their
   last word. The factor only has to dwarf the other items' 1. */
#action-btns[data-beside] #copy-btn {
  flex-shrink: 1000000;
  min-width: 36px;
}
/* more-menu.ts gives an item a title when its label is cut. The copy item then shows its icon, not part of a label. */
#action-btns[data-beside] #copy-btn[title] .more-item-label {
  display: none;
}
/* The menu and the toast share the top of the iframe, so the row closes while the toast shows. So does the drop-down
   where the widest toast reaches it at the default text size. */
#copy-toast.visible ~ #action-btns[data-beside] #more-popover {
  opacity: 0;
  visibility: hidden;
}
@media (max-width: 640px) {
  #copy-toast.visible ~ #action-btns #more-popover {
    opacity: 0;
    visibility: hidden;
  }
}
/* The ring copies the design system's Spinner (md, inheritColor) so the two look alike. */
.more-item[aria-busy="true"] {
  cursor: progress;
}
.more-item[aria-busy="true"] .more-item-icon {
  position: relative;
}
.more-item[aria-busy="true"] .more-item-icon svg {
  visibility: hidden;
}
.more-item[aria-busy="true"] .more-item-icon::before,
.more-item[aria-busy="true"] .more-item-icon::after {
  content: "";
  position: absolute;
  inset: 2px;
  border-radius: 50%;
}
.more-item[aria-busy="true"] .more-item-icon::before {
  border: 1.75px solid color-mix(in srgb, currentColor 25%, transparent);
}
.more-item[aria-busy="true"] .more-item-icon::after {
  background: conic-gradient(transparent 40%, currentColor);
  -webkit-mask: radial-gradient(
    farthest-side,
    transparent calc(100% - 1.75px),
    #000 calc(100% - 1.25px)
  );
  mask: radial-gradient(
    farthest-side,
    transparent calc(100% - 1.75px),
    #000 calc(100% - 1.25px)
  );
  animation: moreItemSpin 1s linear infinite;
}
@keyframes moreItemSpin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .more-item[aria-busy="true"] .more-item-icon::after {
    animation: none;
  }
}
/* The line send-prompt.ts shows. The sibling selector keeps these rules off a visual's own id="not-sent". */
/* Without this rule, a visual's own div or body rules (padding, a flex gap) would give the empty wrapper room. */
#vis-container ~ #not-sent {
  all: revert;
  position: absolute;
}
/* send-prompt.ts sets data-not-sent while the line shows. It is on body because flex-wrap has to change on body itself. */
/* The wrapper then takes room again, under the visual rather than beside it when the visual's own rules lay body out as a row or in columns. */
body[data-not-sent] {
  flex-wrap: wrap;
}
body[data-not-sent] > #vis-container ~ #not-sent {
  position: static;
  width: 100%;
  grid-column: 1 / -1;
}
/* In full screen the grid's column is as wide as the zoomed visual; the line stays inside the view. */
:root[data-open-larger] body[data-not-sent] > #vis-container ~ #not-sent {
  max-width: calc(
    100vw - var(--host-inset-left, 0px) - var(--host-inset-right, 0px) - 24px -
      var(--larger-button-size) - 14px - var(--larger-lead-x, 0px)
  );
}
#vis-container ~ #not-sent > p {
  margin-top: 8px;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: calc(var(--font-text-sm-size, 14px) * 13 / 14);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
/* A visual's own rule such as p { display: flex } would beat the browser's [hidden] rule. */
#vis-container ~ #not-sent > p[hidden] {
  display: none;
}
#copy-toast {
  position: fixed;
  /* For a browser without the lh unit, which drops the next line and would leave this below the visual, out of sight. */
  top: 12px;
  /* Centres a one-line toast in an iframe too short for 12px above and below it. 18px is its padding and border. */
  top: min(12px, (100vh - 1lh - 18px) / 2);
  left: 50%;
  transform: translateX(-50%) translateY(-20px);
  background: var(--bg-danger);
  color: var(--text-danger);
  border: 1px solid var(--border-danger);
  font-family: var(--font-sans);
  font-size: calc(var(--font-text-sm-size, 14px) * 13 / 14);
  padding: 8px 14px;
  border-radius: var(--radius);
  pointer-events: none;
  opacity: 0;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  z-index: 2147483647;
  /* Wraps where a line does not fit. 88px is the 28px trigger with 8px either side of it, and the same on the left. */
  box-sizing: border-box;
  width: max-content;
  max-width: calc(100vw - 88px);
  text-align: center;
  white-space: pre-line;
}
#copy-toast.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* HTML scripts-loading shimmer */
#vis-container.scripts-loading {
  pointer-events: none;
  opacity: 0.7;
}
#vis-container.scripts-loading::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 10000;
  overflow: hidden;
}
#vis-container.scripts-loading::before {
  content: "";
  position: absolute;
  top: -50%;
  left: 0;
  width: 60%;
  height: 200%;
  z-index: 10001;
  background: linear-gradient(
    90deg,
    transparent 0%,
    light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08)) 50%,
    transparent 100%
  );
  animation: scriptsShimmer 2s ease-in-out infinite;
}
@keyframes scriptsShimmer {
  0% {
    transform: translateX(-100%) rotate(25deg);
  }
  100% {
    transform: translateX(200%) rotate(25deg);
  }
}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
  <style id="entry-animation">/* Entry animation for streaming SVG elements.
   Scoped to #vis-container.streaming — widget-main.ts adds the class on first
   tool-input-partial and removes it on tool-input. After streaming, scripts
   that rebuild SVG via innerHTML (e.g. slider-driven charts) won't trigger this.
   Uses CSS individual transform property (scale) to avoid conflicts with SVG transform attribute.
   Excludes elements with transform/opacity attributes to prevent CSS overriding SVG values. */
@keyframes svgFadeInScale {
  from {
    opacity: 0;
    scale: 0.95;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}
#vis-container.streaming
  :where(
    svg,
    circle,
    rect,
    path,
    polygon,
    polyline,
    line,
    ellipse,
    g,
    text
  ):not([transform]):not([opacity]) {
  transition:
    fill 0.4s ease-out,
    stroke 0.4s ease-out,
    opacity 0.4s ease-out;
  animation: svgFadeInScale 0.5s ease-out;
  transform-origin: center;
}</style>
  <link id="icon-font" rel="stylesheet" href="/libs/imagine/tabler-icons-webfont-3.42.0/tabler-icons.min.css" data-cdn-href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.42.0/dist/tabler-icons.min.css" media="print" onload="this.media='all'" onerror="this.dataset.failed=''">
</head>
<body>
  <!-- Pre-defined SVG markers — available to all SVGs via url(#arrow) -->
  <svg style="position:absolute;width:0;height:0" aria-hidden="true">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </marker>
    </defs>
  </svg>
  <div id="vis-container"></div>
  <div id="not-sent" role="status"><p hidden><span data-i18n="notSent">Not sent:</span> <q dir="auto"></q></p></div>
  <div id="copy-toast"></div>
  <div id="action-btns" hidden>
    <button id="more-btn" aria-label="More actions" data-i18n-aria-label="moreLabel">
      <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path d="M4.5 8.5C5.32843 8.5 6 9.17157 6 10C6 10.8284 5.32843 11.5 4.5 11.5C3.67157 11.5 3 10.8284 3 10C3 9.17157 3.67157 8.5 4.5 8.5ZM10 8.5C10.8284 8.5 11.5 9.17157 11.5 10C11.5 10.8284 10.8284 11.5 10 11.5C9.17157 11.5 8.5 10.8284 8.5 10C8.5 9.17157 9.17157 8.5 10 8.5ZM15.5 8.5C16.3284 8.5 17 9.17157 17 10C17 10.8284 16.3284 11.5 15.5 11.5C14.6716 11.5 14 10.8284 14 10C14 9.17157 14.6716 8.5 15.5 8.5Z"/></svg>
    </button>
    <div id="more-popover">
      <button class="more-item" id="copy-btn">
        <span class="more-item-icon" id="copy-icon"></span>
        <span class="more-item-label" data-i18n="clipLabel">Copy as image</span>
      </button>
      <button class="more-item" id="download-btn">
        <span class="more-item-icon" id="download-icon"></span>
        <span class="more-item-label" data-i18n="grabLabel">Download as HTML</span>
      </button>
      <button class="more-item" id="png-btn" hidden>
        <span class="more-item-icon" id="png-icon"></span>
        <span class="more-item-label" data-i18n="pngLabel">Download as PNG</span>
      </button>
    </div>
  </div>
  <div id="larger-btns">
    <button id="larger-open" type="button" aria-label="View larger" data-i18n-aria-label="openLargerLabel" data-resting hidden>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5h4.5V8M16.5 3.5l-5 5M8 16.5H3.5V12M3.5 16.5l5-5"/></svg>
    </button>
    <div id="larger-zoom" role="group" aria-label="Zoom" data-i18n-aria-label="zoomLabel" hidden>
      <button id="larger-zoom-in" type="button" aria-label="Zoom in" data-i18n-aria-label="zoomInLabel">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 10h10M10 5v10"/></svg>
      </button>
      <button id="larger-zoom-out" type="button" aria-label="Zoom out" data-i18n-aria-label="zoomOutLabel">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 10h10"/></svg>
      </button>
    </div>
    <span id="larger-zoom-status" class="sr-only" role="status"></span>
  </div>
  <script type="module">
"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/html-to-image/es/util.js
  function resolveUrl(url, baseUrl) {
    if (url.match(/^[a-z]+:\/\//i)) {
      return url;
    }
    if (url.match(/^\/\//)) {
      return window.location.protocol + url;
    }
    if (url.match(/^[a-z]+:/i)) {
      return url;
    }
    const doc = document.implementation.createHTMLDocument();
    const base = doc.createElement("base");
    const a = doc.createElement("a");
    doc.head.appendChild(base);
    doc.body.appendChild(a);
    if (baseUrl) {
      base.href = baseUrl;
    }
    a.href = url;
    return a.href;
  }
  var uuid = /* @__PURE__ */ (() => {
    let counter = 0;
    const random = () => (
      // eslint-disable-next-line no-bitwise
      `0000${(Math.random() * 36 ** 4 << 0).toString(36)}`.slice(-4)
    );
    return () => {
      counter += 1;
      return `u${random()}${counter}`;
    };
  })();
  function toArray(arrayLike) {
    const arr = [];
    for (let i = 0, l = arrayLike.length; i < l; i++) {
      arr.push(arrayLike[i]);
    }
    return arr;
  }
  var styleProps = null;
  function getStyleProperties(options = {}) {
    if (styleProps) {
      return styleProps;
    }
    if (options.includeStyleProperties) {
      styleProps = options.includeStyleProperties;
      return styleProps;
    }
    styleProps = toArray(window.getComputedStyle(document.documentElement));
    return styleProps;
  }
  function px(node, styleProperty) {
    const win = node.ownerDocument.defaultView || window;
    const val = win.getComputedStyle(node).getPropertyValue(styleProperty);
    return val ? parseFloat(val.replace("px", "")) : 0;
  }
  function getNodeWidth(node) {
    const leftBorder = px(node, "border-left-width");
    const rightBorder = px(node, "border-right-width");
    return node.clientWidth + leftBorder + rightBorder;
  }
  function getNodeHeight(node) {
    const topBorder = px(node, "border-top-width");
    const bottomBorder = px(node, "border-bottom-width");
    return node.clientHeight + topBorder + bottomBorder;
  }
  function getImageSize(targetNode, options = {}) {
    const width = options.width || getNodeWidth(targetNode);
    const height = options.height || getNodeHeight(targetNode);
    return { width, height };
  }
  function createImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        img.decode().then(() => {
          requestAnimationFrame(() => resolve(img));
        });
      };
      img.onerror = reject;
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.src = url;
    });
  }
  async function svgToDataURL(svg) {
    return Promise.resolve().then(() => new XMLSerializer().serializeToString(svg)).then(encodeURIComponent).then((html) => `data:image/svg+xml;charset=utf-8,${html}`);
  }
  async function nodeToDataURL(node, width, height) {
    const xmlns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(xmlns, "svg");
    const foreignObject = document.createElementNS(xmlns, "foreignObject");
    svg.setAttribute("width", `${width}`);
    svg.setAttribute("height", `${height}`);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    foreignObject.setAttribute("width", "100%");
    foreignObject.setAttribute("height", "100%");
    foreignObject.setAttribute("x", "0");
    foreignObject.setAttribute("y", "0");
    foreignObject.setAttribute("externalResourcesRequired", "true");
    svg.appendChild(foreignObject);
    foreignObject.appendChild(node);
    return svgToDataURL(svg);
  }
  var isInstanceOfElement = (node, instance) => {
    if (node instanceof instance)
      return true;
    const nodePrototype = Object.getPrototypeOf(node);
    if (nodePrototype === null)
      return false;
    return nodePrototype.constructor.name === instance.name || isInstanceOfElement(nodePrototype, instance);
  };

  // node_modules/html-to-image/es/clone-pseudos.js
  function formatCSSText(style) {
    const content = style.getPropertyValue("content");
    return `${style.cssText} content: '${content.replace(/'|"/g, "")}';`;
  }
  function formatCSSProperties(style, options) {
    return getStyleProperties(options).map((name) => {
      const value = style.getPropertyValue(name);
      const priority = style.getPropertyPriority(name);
      return `${name}: ${value}${priority ? " !important" : ""};`;
    }).join(" ");
  }
  function getPseudoElementStyle(className, pseudo, style, options) {
    const selector = `.${className}:${pseudo}`;
    const cssText = style.cssText ? formatCSSText(style) : formatCSSProperties(style, options);
    return document.createTextNode(`${selector}{${cssText}}`);
  }
  function clonePseudoElement(nativeNode, clonedNode, pseudo, options) {
    const style = window.getComputedStyle(nativeNode, pseudo);
    const content = style.getPropertyValue("content");
    if (content === "" || content === "none") {
      return;
    }
    const className = uuid();
    try {
      clonedNode.className = `${clonedNode.className} ${className}`;
    } catch (err) {
      return;
    }
    const styleElement = document.createElement("style");
    styleElement.appendChild(getPseudoElementStyle(className, pseudo, style, options));
    clonedNode.appendChild(styleElement);
  }
  function clonePseudoElements(nativeNode, clonedNode, options) {
    clonePseudoElement(nativeNode, clonedNode, ":before", options);
    clonePseudoElement(nativeNode, clonedNode, ":after", options);
  }

  // node_modules/html-to-image/es/mimes.js
  var WOFF = "application/font-woff";
  var JPEG = "image/jpeg";
  var mimes = {
    woff: WOFF,
    woff2: WOFF,
    ttf: "application/font-truetype",
    eot: "application/vnd.ms-fontobject",
    png: "image/png",
    jpg: JPEG,
    jpeg: JPEG,
    gif: "image/gif",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    webp: "image/webp"
  };
  function getExtension(url) {
    const match = /\.([^./]*?)$/g.exec(url);
    return match ? match[1] : "";
  }
  function getMimeType(url) {
    const extension = getExtension(url).toLowerCase();
    return mimes[extension] || "";
  }

  // node_modules/html-to-image/es/dataurl.js
  function getContentFromDataUrl(dataURL) {
    return dataURL.split(/,/)[1];
  }
  function isDataUrl(url) {
    return url.search(/^(data:)/) !== -1;
  }
  function makeDataUrl(content, mimeType) {
    return `data:${mimeType};base64,${content}`;
  }
  async function fetchAsDataURL(url, init, process2) {
    const res = await fetch(url, init);
    if (res.status === 404) {
      throw new Error(`Resource "${res.url}" not found`);
    }
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onloadend = () => {
        try {
          resolve(process2({ res, result: reader.result }));
        } catch (error) {
          reject(error);
        }
      };
      reader.readAsDataURL(blob);
    });
  }
  var cache = {};
  function getCacheKey(url, contentType, includeQueryParams) {
    let key = url.replace(/\?.*/, "");
    if (includeQueryParams) {
      key = url;
    }
    if (/ttf|otf|eot|woff2?/i.test(key)) {
      key = key.replace(/.*\//, "");
    }
    return contentType ? `[${contentType}]${key}` : key;
  }
  async function resourceToDataURL(resourceUrl, contentType, options) {
    const cacheKey = getCacheKey(resourceUrl, contentType, options.includeQueryParams);
    if (cache[cacheKey] != null) {
      return cache[cacheKey];
    }
    if (options.cacheBust) {
      resourceUrl += (/\?/.test(resourceUrl) ? "&" : "?") + (/* @__PURE__ */ new Date()).getTime();
    }
    let dataURL;
    try {
      const content = await fetchAsDataURL(resourceUrl, options.fetchRequestInit, ({ res, result }) => {
        if (!contentType) {
          contentType = res.headers.get("Content-Type") || "";
        }
        return getContentFromDataUrl(result);
      });
      dataURL = makeDataUrl(content, contentType);
    } catch (error) {
      dataURL = options.imagePlaceholder || "";
      let msg = `Failed to fetch resource: ${resourceUrl}`;
      if (error) {
        msg = typeof error === "string" ? error : error.message;
      }
      if (msg) {
        console.warn(msg);
      }
    }
    cache[cacheKey] = dataURL;
    return dataURL;
  }

  // node_modules/html-to-image/es/clone-node.js
  async function cloneCanvasElement(canvas) {
    const dataURL = canvas.toDataURL();
    if (dataURL === "data:,") {
      return canvas.cloneNode(false);
    }
    return createImage(dataURL);
  }
  async function cloneVideoElement(video, options) {
    if (video.currentSrc) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = video.clientWidth;
      canvas.height = video.clientHeight;
      ctx === null || ctx === void 0 ? void 0 : ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataURL2 = canvas.toDataURL();
      return createImage(dataURL2);
    }
    const poster = video.poster;
    const contentType = getMimeType(poster);
    const dataURL = await resourceToDataURL(poster, contentType, options);
    return createImage(dataURL);
  }
  async function cloneIFrameElement(iframe, options) {
    var _a;
    try {
      if ((_a = iframe === null || iframe === void 0 ? void 0 : iframe.contentDocument) === null || _a === void 0 ? void 0 : _a.body) {
        return await cloneNode(iframe.contentDocument.body, options, true);
      }
    } catch (_b) {
    }
    return iframe.cloneNode(false);
  }
  async function cloneSingleNode(node, options) {
    if (isInstanceOfElement(node, HTMLCanvasElement)) {
      return cloneCanvasElement(node);
    }
    if (isInstanceOfElement(node, HTMLVideoElement)) {
      return cloneVideoElement(node, options);
    }
    if (isInstanceOfElement(node, HTMLIFrameElement)) {
      return cloneIFrameElement(node, options);
    }
    return node.cloneNode(isSVGElement(node));
  }
  var isSlotElement = (node) => node.tagName != null && node.tagName.toUpperCase() === "SLOT";
  var isSVGElement = (node) => node.tagName != null && node.tagName.toUpperCase() === "SVG";
  async function cloneChildren(nativeNode, clonedNode, options) {
    var _a, _b;
    if (isSVGElement(clonedNode)) {
      return clonedNode;
    }
    let children = [];
    if (isSlotElement(nativeNode) && nativeNode.assignedNodes) {
      children = toArray(nativeNode.assignedNodes());
    } else if (isInstanceOfElement(nativeNode, HTMLIFrameElement) && ((_a = nativeNode.contentDocument) === null || _a === void 0 ? void 0 : _a.body)) {
      children = toArray(nativeNode.contentDocument.body.childNodes);
    } else {
      children = toArray(((_b = nativeNode.shadowRoot) !== null && _b !== void 0 ? _b : nativeNode).childNodes);
    }
    if (children.length === 0 || isInstanceOfElement(nativeNode, HTMLVideoElement)) {
      return clonedNode;
    }
    await children.reduce((deferred, child) => deferred.then(() => cloneNode(child, options)).then((clonedChild) => {
      if (clonedChild) {
        clonedNode.appendChild(clonedChild);
      }
    }), Promise.resolve());
    return clonedNode;
  }
  function cloneCSSStyle(nativeNode, clonedNode, options) {
    const targetStyle = clonedNode.style;
    if (!targetStyle) {
      return;
    }
    const sourceStyle = window.getComputedStyle(nativeNode);
    if (sourceStyle.cssText) {
      targetStyle.cssText = sourceStyle.cssText;
      targetStyle.transformOrigin = sourceStyle.transformOrigin;
    } else {
      getStyleProperties(options).forEach((name) => {
        let value = sourceStyle.getPropertyValue(name);
        if (name === "font-size" && value.endsWith("px")) {
          const reducedFont = Math.floor(parseFloat(value.substring(0, value.length - 2))) - 0.1;
          value = `${reducedFont}px`;
        }
        if (isInstanceOfElement(nativeNode, HTMLIFrameElement) && name === "display" && value === "inline") {
          value = "block";
        }
        if (name === "d" && clonedNode.getAttribute("d")) {
          value = `path(${clonedNode.getAttribute("d")})`;
        }
        targetStyle.setProperty(name, value, sourceStyle.getPropertyPriority(name));
      });
    }
  }
  function cloneInputValue(nativeNode, clonedNode) {
    if (isInstanceOfElement(nativeNode, HTMLTextAreaElement)) {
      clonedNode.innerHTML = nativeNode.value;
    }
    if (isInstanceOfElement(nativeNode, HTMLInputElement)) {
      clonedNode.setAttribute("value", nativeNode.value);
    }
  }
  function cloneSelectValue(nativeNode, clonedNode) {
    if (isInstanceOfElement(nativeNode, HTMLSelectElement)) {
      const clonedSelect = clonedNode;
      const selectedOption = Array.from(clonedSelect.children).find((child) => nativeNode.value === child.getAttribute("value"));
      if (selectedOption) {
        selectedOption.setAttribute("selected", "");
      }
    }
  }
  function decorate(nativeNode, clonedNode, options) {
    if (isInstanceOfElement(clonedNode, Element)) {
      cloneCSSStyle(nativeNode, clonedNode, options);
      clonePseudoElements(nativeNode, clonedNode, options);
      cloneInputValue(nativeNode, clonedNode);
      cloneSelectValue(nativeNode, clonedNode);
    }
    return clonedNode;
  }
  async function ensureSVGSymbols(clone, options) {
    const uses = clone.querySelectorAll ? clone.querySelectorAll("use") : [];
    if (uses.length === 0) {
      return clone;
    }
    const processedDefs = {};
    for (let i = 0; i < uses.length; i++) {
      const use = uses[i];
      const id = use.getAttribute("xlink:href");
      if (id) {
        const exist = clone.querySelector(id);
        const definition = document.querySelector(id);
        if (!exist && definition && !processedDefs[id]) {
          processedDefs[id] = await cloneNode(definition, options, true);
        }
      }
    }
    const nodes = Object.values(processedDefs);
    if (nodes.length) {
      const ns = "http://www.w3.org/1999/xhtml";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("xmlns", ns);
      svg.style.position = "absolute";
      svg.style.width = "0";
      svg.style.height = "0";
      svg.style.overflow = "hidden";
      svg.style.display = "none";
      const defs = document.createElementNS(ns, "defs");
      svg.appendChild(defs);
      for (let i = 0; i < nodes.length; i++) {
        defs.appendChild(nodes[i]);
      }
      clone.appendChild(svg);
    }
    return clone;
  }
  async function cloneNode(node, options, isRoot) {
    if (!isRoot && options.filter && !options.filter(node)) {
      return null;
    }
    return Promise.resolve(node).then((clonedNode) => cloneSingleNode(clonedNode, options)).then((clonedNode) => cloneChildren(node, clonedNode, options)).then((clonedNode) => decorate(node, clonedNode, options)).then((clonedNode) => ensureSVGSymbols(clonedNode, options));
  }

  // node_modules/html-to-image/es/embed-resources.js
  var URL_REGEX = /url\((['"]?)([^'"]+?)\1\)/g;
  var URL_WITH_FORMAT_REGEX = /url\([^)]+\)\s*format\((["']?)([^"']+)\1\)/g;
  var FONT_SRC_REGEX = /src:\s*(?:url\([^)]+\)\s*format\([^)]+\)[,;]\s*)+/g;
  function toRegex(url) {
    const escaped = url.replace(/([.*+?^${}()|\[\]\/\\])/g, "\\$1");
    return new RegExp(`(url\\(['"]?)(${escaped})(['"]?\\))`, "g");
  }
  function parseURLs(cssText) {
    const urls = [];
    cssText.replace(URL_REGEX, (raw, quotation, url) => {
      urls.push(url);
      return raw;
    });
    return urls.filter((url) => !isDataUrl(url));
  }
  async function embed(cssText, resourceURL, baseURL, options, getContentFromUrl) {
    try {
      const resolvedURL = baseURL ? resolveUrl(resourceURL, baseURL) : resourceURL;
      const contentType = getMimeType(resourceURL);
      let dataURL;
      if (getContentFromUrl) {
        const content = await getContentFromUrl(resolvedURL);
        dataURL = makeDataUrl(content, contentType);
      } else {
        dataURL = await resourceToDataURL(resolvedURL, contentType, options);
      }
      return cssText.replace(toRegex(resourceURL), `$1${dataURL}$3`);
    } catch (error) {
    }
    return cssText;
  }
  function filterPreferredFontFormat(str, { preferredFontFormat }) {
    return !preferredFontFormat ? str : str.replace(FONT_SRC_REGEX, (match) => {
      while (true) {
        const [src, , format] = URL_WITH_FORMAT_REGEX.exec(match) || [];
        if (!format) {
          return "";
        }
        if (format === preferredFontFormat) {
          return `src: ${src};`;
        }
      }
    });
  }
  function shouldEmbed(url) {
    return url.search(URL_REGEX) !== -1;
  }
  async function embedResources(cssText, baseUrl, options) {
    if (!shouldEmbed(cssText)) {
      return cssText;
    }
    const filteredCSSText = filterPreferredFontFormat(cssText, options);
    const urls = parseURLs(filteredCSSText);
    return urls.reduce((deferred, url) => deferred.then((css) => embed(css, url, baseUrl, options)), Promise.resolve(filteredCSSText));
  }

  // node_modules/html-to-image/es/embed-images.js
  async function embedProp(propName, node, options) {
    var _a;
    const propValue = (_a = node.style) === null || _a === void 0 ? void 0 : _a.getPropertyValue(propName);
    if (propValue) {
      const cssString = await embedResources(propValue, null, options);
      node.style.setProperty(propName, cssString, node.style.getPropertyPriority(propName));
      return true;
    }
    return false;
  }
  async function embedBackground(clonedNode, options) {
    ;
    await embedProp("background", clonedNode, options) || await embedProp("background-image", clonedNode, options);
    await embedProp("mask", clonedNode, options) || await embedProp("-webkit-mask", clonedNode, options) || await embedProp("mask-image", clonedNode, options) || await embedProp("-webkit-mask-image", clonedNode, options);
  }
  async function embedImageNode(clonedNode, options) {
    const isImageElement = isInstanceOfElement(clonedNode, HTMLImageElement);
    if (!(isImageElement && !isDataUrl(clonedNode.src)) && !(isInstanceOfElement(clonedNode, SVGImageElement) && !isDataUrl(clonedNode.href.baseVal))) {
      return;
    }
    const url = isImageElement ? clonedNode.src : clonedNode.href.baseVal;
    const dataURL = await resourceToDataURL(url, getMimeType(url), options);
    await new Promise((resolve, reject) => {
      clonedNode.onload = resolve;
      clonedNode.onerror = options.onImageErrorHandler ? (...attributes) => {
        try {
          resolve(options.onImageErrorHandler(...attributes));
        } catch (error) {
          reject(error);
        }
      } : reject;
      const image = clonedNode;
      if (image.decode) {
        image.decode = resolve;
      }
      if (image.loading === "lazy") {
        image.loading = "eager";
      }
      if (isImageElement) {
        clonedNode.srcset = "";
        clonedNode.src = dataURL;
      } else {
        clonedNode.href.baseVal = dataURL;
      }
    });
  }
  async function embedChildren(clonedNode, options) {
    const children = toArray(clonedNode.childNodes);
    const deferreds = children.map((child) => embedImages(child, options));
    await Promise.all(deferreds).then(() => clonedNode);
  }
  async function embedImages(clonedNode, options) {
    if (isInstanceOfElement(clonedNode, Element)) {
      await embedBackground(clonedNode, options);
      await embedImageNode(clonedNode, options);
      await embedChildren(clonedNode, options);
    }
  }

  // node_modules/html-to-image/es/apply-style.js
  function applyStyle(node, options) {
    const { style } = node;
    if (options.backgroundColor) {
      style.backgroundColor = options.backgroundColor;
    }
    if (options.width) {
      style.width = `${options.width}px`;
    }
    if (options.height) {
      style.height = `${options.height}px`;
    }
    const manual = options.style;
    if (manual != null) {
      Object.keys(manual).forEach((key) => {
        style[key] = manual[key];
      });
    }
    return node;
  }

  // node_modules/html-to-image/es/embed-webfonts.js
  var cssFetchCache = {};
  async function fetchCSS(url) {
    let cache2 = cssFetchCache[url];
    if (cache2 != null) {
      return cache2;
    }
    const res = await fetch(url);
    const cssText = await res.text();
    cache2 = { url, cssText };
    cssFetchCache[url] = cache2;
    return cache2;
  }
  async function embedFonts(data, options) {
    let cssText = data.cssText;
    const regexUrl = /url\(["']?([^"')]+)["']?\)/g;
    const fontLocs = cssText.match(/url\([^)]+\)/g) || [];
    const loadFonts = fontLocs.map(async (loc) => {
      let url = loc.replace(regexUrl, "$1");
      if (!url.startsWith("https://")) {
        url = new URL(url, data.url).href;
      }
      return fetchAsDataURL(url, options.fetchRequestInit, ({ result }) => {
        cssText = cssText.replace(loc, `url(${result})`);
        return [loc, result];
      });
    });
    return Promise.all(loadFonts).then(() => cssText);
  }
  function parseCSS(source) {
    if (source == null) {
      return [];
    }
    const result = [];
    const commentsRegex = /(\/\*[\s\S]*?\*\/)/gi;
    let cssText = source.replace(commentsRegex, "");
    const keyframesRegex = new RegExp("((@.*?keyframes [\\s\\S]*?){([\\s\\S]*?}\\s*?)})", "gi");
    while (true) {
      const matches = keyframesRegex.exec(cssText);
      if (matches === null) {
        break;
      }
      result.push(matches[0]);
    }
    cssText = cssText.replace(keyframesRegex, "");
    const importRegex = /@import[\s\S]*?url\([^)]*\)[\s\S]*?;/gi;
    const combinedCSSRegex = "((\\s*?(?:\\/\\*[\\s\\S]*?\\*\\/)?\\s*?@media[\\s\\S]*?){([\\s\\S]*?)}\\s*?})|(([\\s\\S]*?){([\\s\\S]*?)})";
    const unifiedRegex = new RegExp(combinedCSSRegex, "gi");
    while (true) {
      let matches = importRegex.exec(cssText);
      if (matches === null) {
        matches = unifiedRegex.exec(cssText);
        if (matches === null) {
          break;
        } else {
          importRegex.lastIndex = unifiedRegex.lastIndex;
        }
      } else {
        unifiedRegex.lastIndex = importRegex.lastIndex;
      }
      result.push(matches[0]);
    }
    return result;
  }
  async function getCSSRules(styleSheets, options) {
    const ret = [];
    const deferreds = [];
    styleSheets.forEach((sheet) => {
      if ("cssRules" in sheet) {
        try {
          toArray(sheet.cssRules || []).forEach((item, index) => {
            if (item.type === CSSRule.IMPORT_RULE) {
              let importIndex = index + 1;
              const url = item.href;
              const deferred = fetchCSS(url).then((metadata) => embedFonts(metadata, options)).then((cssText) => parseCSS(cssText).forEach((rule) => {
                try {
                  sheet.insertRule(rule, rule.startsWith("@import") ? importIndex += 1 : sheet.cssRules.length);
                } catch (error) {
                  console.error("Error inserting rule from remote css", {
                    rule,
                    error
                  });
                }
              })).catch((e) => {
                console.error("Error loading remote css", e.toString());
              });
              deferreds.push(deferred);
            }
          });
        } catch (e) {
          const inline = styleSheets.find((a) => a.href == null) || document.styleSheets[0];
          if (sheet.href != null) {
            deferreds.push(fetchCSS(sheet.href).then((metadata) => embedFonts(metadata, options)).then((cssText) => parseCSS(cssText).forEach((rule) => {
              inline.insertRule(rule, inline.cssRules.length);
            })).catch((err) => {
              console.error("Error loading remote stylesheet", err);
            }));
          }
          console.error("Error inlining remote css file", e);
        }
      }
    });
    return Promise.all(deferreds).then(() => {
      styleSheets.forEach((sheet) => {
        if ("cssRules" in sheet) {
          try {
            toArray(sheet.cssRules || []).forEach((item) => {
              ret.push(item);
            });
          } catch (e) {
            console.error(`Error while reading CSS rules from ${sheet.href}`, e);
          }
        }
      });
      return ret;
    });
  }
  function getWebFontRules(cssRules) {
    return cssRules.filter((rule) => rule.type === CSSRule.FONT_FACE_RULE).filter((rule) => shouldEmbed(rule.style.getPropertyValue("src")));
  }
  async function parseWebFontRules(node, options) {
    if (node.ownerDocument == null) {
      throw new Error("Provided element is not within a Document");
    }
    const styleSheets = toArray(node.ownerDocument.styleSheets);
    const cssRules = await getCSSRules(styleSheets, options);
    return getWebFontRules(cssRules);
  }
  function normalizeFontFamily(font) {
    return font.trim().replace(/["']/g, "");
  }
  function getUsedFonts(node) {
    const fonts = /* @__PURE__ */ new Set();
    function traverse(node2) {
      const fontFamily = node2.style.fontFamily || getComputedStyle(node2).fontFamily;
      fontFamily.split(",").forEach((font) => {
        fonts.add(normalizeFontFamily(font));
      });
      Array.from(node2.children).forEach((child) => {
        if (child instanceof HTMLElement) {
          traverse(child);
        }
      });
    }
    traverse(node);
    return fonts;
  }
  async function getWebFontCSS(node, options) {
    const rules = await parseWebFontRules(node, options);
    const usedFonts = getUsedFonts(node);
    const cssTexts = await Promise.all(rules.filter((rule) => usedFonts.has(normalizeFontFamily(rule.style.fontFamily))).map((rule) => {
      const baseUrl = rule.parentStyleSheet ? rule.parentStyleSheet.href : null;
      return embedResources(rule.cssText, baseUrl, options);
    }));
    return cssTexts.join("\n");
  }
  async function embedWebFonts(clonedNode, options) {
    const cssText = options.fontEmbedCSS != null ? options.fontEmbedCSS : options.skipFonts ? null : await getWebFontCSS(clonedNode, options);
    if (cssText) {
      const styleNode = document.createElement("style");
      const sytleContent = document.createTextNode(cssText);
      styleNode.appendChild(sytleContent);
      if (clonedNode.firstChild) {
        clonedNode.insertBefore(styleNode, clonedNode.firstChild);
      } else {
        clonedNode.appendChild(styleNode);
      }
    }
  }

  // node_modules/html-to-image/es/index.js
  async function toSvg(node, options = {}) {
    const { width, height } = getImageSize(node, options);
    const clonedNode = await cloneNode(node, options, true);
    await embedWebFonts(clonedNode, options);
    await embedImages(clonedNode, options);
    applyStyle(clonedNode, options);
    const datauri = await nodeToDataURL(clonedNode, width, height);
    return datauri;
  }

  // src/scripts/copy-canvas.ts
  var WRAPPER_OPENS = "data:image/svg+xml;charset=utf-8,%3Csvg";
  var LARGEST_CANVAS_SIDE = 16384;
  function withPageMode(markup, mode) {
    if (!mode || !/^[\w-]+$/.test(mode) || !markup.startsWith(`${WRAPPER_OPENS}%20`)) {
      return markup;
    }
    return `${WRAPPER_OPENS}%20data-mode%3D%22${mode}%22${markup.slice(WRAPPER_OPENS.length)}`;
  }
  function nextFrame() {
    return new Promise((resolve) => {
      setTimeout(resolve, 100);
      requestAnimationFrame(() => resolve());
    });
  }
  async function toCanvas(node, options) {
    const mode = node.getAttribute("data-mode");
    const markup = await toSvg(node, options);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.src = withPageMode(markup, mode);
    await image.decode();
    await nextFrame();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("No 2d context");
    }
    const fullWidth = options.width * options.pixelRatio;
    const fullHeight = options.height * options.pixelRatio;
    const longest = Math.max(fullWidth, fullHeight, LARGEST_CANVAS_SIDE);
    canvas.width = Math.floor(fullWidth * LARGEST_CANVAS_SIDE / longest);
    canvas.height = Math.floor(fullHeight * LARGEST_CANVAS_SIDE / longest);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // src/scripts/proxy-page.ts
  var proxyPage = window.parent;

  // src/scripts/wide-clip.ts
  var WHOLE_WIDTH = "whole-width";
  var WIDEST_IN_FRAMES = 4;

  // src/scripts/clipboard-copy.ts
  function inkBox({
    data,
    width,
    height
  }) {
    let top = -1;
    let bottom = -1;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y += 1) {
      const opacityAt = y * width * 4 + 3;
      let first = 0;
      while (first < width && data[opacityAt + first * 4] === 0) {
        first += 1;
      }
      if (first < width) {
        let last2 = width - 1;
        while (data[opacityAt + last2 * 4] === 0) {
          last2 -= 1;
        }
        if (top === -1) {
          top = y;
        }
        bottom = y;
        left = Math.min(left, first);
        right = Math.max(right, last2);
      }
    }
    return top === -1 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }
  var PAGE_COLOUR = "var(--surface-1)";
  var MARGIN = 16;
  var LARGEST_CANVAS_AREA = 4096 * 4096;
  function roomAround(width, height, margin) {
    let room = Math.min(
      margin,
      Math.floor((LARGEST_CANVAS_SIDE - Math.max(width, height)) / 2)
    );
    const area = (around) => (width + 2 * around) * (height + 2 * around);
    if (area(0) <= LARGEST_CANVAS_AREA) {
      while (area(room) > LARGEST_CANVAS_AREA) {
        room--;
      }
    }
    return room;
  }
  function trimToInk(canvas, margin) {
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    let drawn;
    try {
      drawn = context.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    const box = inkBox(drawn);
    if (box === null) {
      return;
    }
    const room = roomAround(box.width, box.height, margin);
    canvas.width = box.width + 2 * room;
    canvas.height = box.height + 2 * room;
    context.putImageData(
      drawn,
      room - box.x,
      room - box.y,
      box.x,
      box.y,
      box.width,
      box.height
    );
  }
  function paintBehind(canvas, colour) {
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = colour;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  function pageColour() {
    const probe = document.createElement("div");
    probe.style.cssText = `display: none; background-color: ${PAGE_COLOUR} !important`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }
  function nextFrameDrawn() {
    return new Promise((resolve) => {
      setTimeout(resolve, 100);
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }
  var TEXT_PAINT_LEFT_TO_RULES = /* @__PURE__ */ new Set([
    "-webkit-text-fill-color",
    "-webkit-text-stroke-color",
    "text-emphasis-color"
  ]);
  var FONT_FACE_RULES = /@font-face\s*\{[^}]*\}/gi;
  function headSheets() {
    return Array.from(
      document.head.querySelectorAll("style"),
      (sheet) => (sheet.textContent ?? "").replace(FONT_FACE_RULES, "")
    ).join("\n");
  }
  var SETTLED = "*, *::before, *::after { animation-delay: -1000000s !important; transition: none !important; }";
  async function asDataUrl(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 32768) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
    }
    return `data:${file.type};base64,${btoa(binary)}`;
  }
  async function ownFontsEmbedded() {
    const faces = Array.from(document.body.querySelectorAll("style")).flatMap(
      (sheet) => (sheet.textContent ?? "").match(FONT_FACE_RULES) ?? []
    );
    const embedded = faces.map(async (face) => {
      let rule = face;
      for (const source of face.match(/url\(["']?https?:[^"')]+["']?\)/g) ?? []) {
        try {
          const fetched = await fetch(
            source.replace(/^url\(["']?|["']?\)$/g, "")
          );
          if (fetched.ok) {
            const embeddedSource = `url("${await asDataUrl(await fetched.blob())}")`;
            rule = rule.replace(source, () => embeddedSource);
          }
        } catch {
        }
      }
      return rule === face ? "" : rule;
    });
    return (await Promise.all(embedded)).join("\n");
  }
  var WHOLE_WIDTH_BLOCK = "whole-width-block";
  var copiesShowingWidth = 0;
  var clipAsBefore;
  function showClippedWidth() {
    if (copiesShowingWidth === 0) {
      const visual2 = document.getElementById("vis-container");
      if (!visual2 || visual2.scrollWidth <= visual2.clientWidth || visual2.scrollWidth > visual2.clientWidth * WIDEST_IN_FRAMES) {
        return () => void 0;
      }
      const { scrollLeft, scrollTop } = visual2;
      const classes = getComputedStyle(visual2).display === "block" ? [WHOLE_WIDTH, WHOLE_WIDTH_BLOCK] : [WHOLE_WIDTH];
      visual2.classList.add(...classes);
      clipAsBefore = () => {
        visual2.classList.remove(...classes);
        visual2.scrollLeft = scrollLeft;
        visual2.scrollTop = scrollTop;
      };
    }
    copiesShowingWidth += 1;
    return () => {
      copiesShowingWidth -= 1;
      if (copiesShowingWidth === 0) {
        clipAsBefore?.();
        clipAsBefore = void 0;
      }
    };
  }
  async function rasterizeBody() {
    await nextFrameDrawn();
    const fonts = await ownFontsEmbedded();
    const clipAgain = showClippedWidth();
    picturesBeingMade += 1;
    document.documentElement.setAttribute(PICTURE, "");
    try {
      return await pictureOfBody(fonts);
    } finally {
      picturesBeingMade -= 1;
      if (picturesBeingMade === 0) {
        document.documentElement.removeAttribute(PICTURE);
      }
      clipAgain();
    }
  }
  var PICTURE = "data-picture";
  var picturesBeingMade = 0;
  async function pictureOfBody(fonts) {
    const width = document.body.scrollWidth || 700;
    const height = document.body.scrollHeight || 400;
    const behind = pageColour();
    const options = {
      pixelRatio: 2,
      width,
      height,
      includeStyleProperties: Array.from(
        getComputedStyle(document.documentElement)
      ).filter((name) => !TEXT_PAINT_LEFT_TO_RULES.has(name)),
      filter: (node) => !(node.parentNode === document.documentElement && node !== document.body || node instanceof HTMLElement && (node.id === "action-btns" || node.id === "larger-btns" && node.parentNode === document.body || node.id === "copy-toast" || node.id === "not-sent" && node.parentNode === document.body))
    };
    const canvas = await toCanvas(document.documentElement, {
      ...options,
      fontEmbedCSS: `${fonts}
${headSheets()}
${SETTLED}`
    });
    trimToInk(canvas, MARGIN * options.pixelRatio);
    paintBehind(canvas, behind);
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      throw new Error("Failed to create PNG");
    }
    return blob;
  }
  async function writePngLocally(png) {
    let item;
    try {
      item = new ClipboardItem({ "image/png": png });
    } catch {
      item = new ClipboardItem({ "image/png": await png });
    }
    await navigator.clipboard.write([item]);
  }
  function hostPageCopies(hostPlatform2) {
    return hostPlatform2 === "web" || hostPlatform2 === "desktop";
  }
  var HOST_COPY_TIMEOUT_MS = 4e3;
  function copyPngViaHost(blob) {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const onMessage = (event) => {
        const data = event.data;
        if (event.source !== proxyPage || data?.type !== "anthropic:copy-image-result" || data.requestId !== requestId) {
          return;
        }
        settle();
        resolve(data.ok === true ? "copy_done_via_host" : "copy_host_refused");
      };
      const timer = setTimeout(() => {
        settle();
        resolve("copy_host_timeout");
      }, HOST_COPY_TIMEOUT_MS);
      const settle = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      };
      window.addEventListener("message", onMessage);
      try {
        proxyPage.postMessage(
          { type: "anthropic:copy-image", requestId, blob },
          "*"
        );
      } catch {
        settle();
        resolve("copy_host_refused");
      }
    });
  }
  async function writePngToClipboard(picture, hostPlatform2) {
    const png = Promise.resolve(picture);
    png.catch(() => void 0);
    const wrote = await writePngLocally(png).then(
      () => true,
      () => false
    );
    if (wrote) {
      return "copy_done";
    }
    let blob;
    try {
      blob = await png;
    } catch {
      return "copy_failed_render";
    }
    return hostPageCopies(hostPlatform2) ? copyPngViaHost(blob) : "copy_refused";
  }
  function copyToClipboard(hostPlatform2) {
    return writePngToClipboard(rasterizeBody(), hostPlatform2);
  }

  // src/scripts/mcp-app-helper.ts
  var app2 = /* @__PURE__ */ (() => {
    let nextId = 100;
    return {
      sendRequest({ method, params }) {
        const id = nextId++;
        proxyPage.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "message",
            function listener(event) {
              if (event.source !== proxyPage) {
                return;
              }
              if (event.data?.id === id) {
                window.removeEventListener("message", listener);
                if (event.data?.result) {
                  resolve(event.data.result);
                } else if (event.data?.error) {
                  const e = event.data.error;
                  reject(
                    new Error(
                      typeof e === "string" ? e : e.message || JSON.stringify(e)
                    )
                  );
                }
              }
            }
          );
        });
      },
      sendNotification({ method, params }) {
        proxyPage.postMessage({ jsonrpc: "2.0", method, params }, "*");
      },
      /**
       * Attach files to the conversation — structured clone carries File objects
       * through postMessage (web-only, mobile relay JSON.stringifies).
       * Uses a non-JSON-RPC shape so PostMessageTransport drops it, raw listener
       * in AppRenderer catches it. Requires real user click (userActivation gate
       * enforced host-side per PR #31090).
       */
      attachFiles(files) {
        proxyPage.postMessage({ type: "anthropic:attach-files", files }, "*");
      },
      onNotification(method, handler) {
        window.addEventListener(
          "message",
          function listener(event) {
            if (event.source !== proxyPage) {
              return;
            }
            if (event.data?.method === method) {
              handler(event.data.params);
            }
          }
        );
      },
      async requestDisplayMode({ mode }) {
        return this.sendRequest({
          method: "ui/request-display-mode",
          params: { mode }
        });
      },
      setupAutoResize() {
        const observer = new ResizeObserver(() => {
          const { body, documentElement: html } = document;
          const htmlStyle = getComputedStyle(html);
          const rect = body.getBoundingClientRect();
          const width = Math.ceil(rect.width);
          const height = Math.ceil(
            rect.height + (parseFloat(htmlStyle.borderTop) || 0) + (parseFloat(htmlStyle.borderBottom) || 0)
          );
          this.sendNotification({
            method: "ui/notifications/size-changed",
            params: { width, height }
          });
        });
        const observe = () => observer.observe(document.body, {
          box: document.documentElement.matches(
            "[data-keep-menu-clear][data-menu-room]"
          ) ? "border-box" : "content-box"
        });
        observe();
        new MutationObserver(observe).observe(document.documentElement, {
          attributeFilter: ["data-keep-menu-clear", "data-menu-room"]
        });
      }
    };
  })();
  window.app = app2;

  // src/scripts/clipboard-text.ts
  var host = app;
  var hostCopiesText = false;
  function readWhetherHostCopiesText(result) {
    hostCopiesText = result.hostContext?._hostCopiesText === true;
  }
  var HOST_COPY_TIMEOUT_MS2 = 4e3;
  function copyViaHost(text) {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const settle = (ending) => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(ending);
      };
      const onMessage = (event) => {
        const data = event.data;
        if (event.source === proxyPage && data?.type === "anthropic:copy-text-result" && data.requestId === requestId) {
          settle(data.ok === true ? "by_page" : "refused");
        }
      };
      const timer = setTimeout(settle, HOST_COPY_TIMEOUT_MS2, "no_answer");
      window.addEventListener("message", onMessage);
      proxyPage.postMessage(
        { type: "anthropic:copy-text", requestId, text },
        "*"
      );
    });
  }
  var rowsLeft = 20;
  function count(ending) {
    if (rowsLeft-- > 0) {
      try {
        host.sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: `viz:copy_text:${ending}`,
            data: { ending }
          }
        });
      } catch {
      }
    }
  }
  var clipboard = navigator.clipboard;
  if (clipboard) {
    const writeText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async (...args) => {
      if (navigator.userActivation?.isActive !== true) {
        return writeText(...args);
      }
      try {
        await writeText(...args);
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotAllowedError") {
          throw error;
        }
        const ending = hostCopiesText ? await copyViaHost(String(args[0])) : "refused";
        count(ending);
        if (ending !== "by_page") {
          throw error;
        }
        return;
      }
      count("by_frame");
    };
  }

  // src/scripts/download-links.ts
  var hostApp = app;
  function fileNameForUri(name, ifEmpty) {
    return name.replace(/[#?%/\\]/g, " ").replace(/\s+/g, " ").trim() || ifEmpty;
  }
  var MAX_BYTES = 20 * 1024 * 1024;
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        resolve(dataUrl.slice(dataUrl.lastIndexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  function sendDownloadLinksToHost(shell) {
    const blobs = /* @__PURE__ */ new Map();
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = (source) => {
      const address = createObjectURL.call(URL, source);
      if (source instanceof Blob) {
        blobs.set(address, source);
      }
      return address;
    };
    URL.revokeObjectURL = (address) => {
      blobs.delete(address);
      revokeObjectURL.call(URL, address);
    };
    const send = async (name, source) => {
      const epoch = shell.acquireDownload();
      if (epoch === null) {
        return;
      }
      try {
        shell.countPress();
        const file = typeof source === "string" ? await (await fetch(source)).blob() : source;
        if (file.size > MAX_BYTES) {
          return;
        }
        await hostApp.sendRequest({
          method: "ui/download-file",
          params: {
            contents: [
              {
                type: "resource",
                resource: {
                  uri: `file:///${fileNameForUri(name, "download")}`,
                  mimeType: file.type || "application/octet-stream",
                  // Not the `text` field: reading as text drops a byte order mark and garbles a file that is not UTF-8.
                  blob: await blobToBase64(file)
                }
              }
            ]
          }
        });
      } catch {
      } finally {
        shell.releaseDownload(epoch);
      }
    };
    const onClick = (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[download][href]") : null;
      if (!anchor || event.defaultPrevented || !navigator.userActivation?.isActive) {
        return;
      }
      if (event.currentTarget === anchor && event.bubbles && !event.cancelBubble && anchor.getRootNode() === document) {
        return;
      }
      const href = anchor.getAttribute("href").trim();
      const source = blobs.get(href) ?? (/^data:/i.test(href) ? href : null);
      if (!source) {
        return;
      }
      event.preventDefault();
      void send(anchor.getAttribute("download"), source);
    };
    window.addEventListener("click", onClick);
    HTMLAnchorElement.prototype.click = function click() {
      this.addEventListener("click", onClick);
      HTMLElement.prototype.click.call(this);
    };
    HTMLAnchorElement.prototype.dispatchEvent = function dispatchEvent(event) {
      this.addEventListener("click", onClick);
      return EventTarget.prototype.dispatchEvent.call(this, event);
    };
  }

  // src/scripts/export-scrub.ts
  var EXECUTABLE_SELECTOR = "script, style, iframe, frame, embed, object, base, meta, link, template, form, animate, set, animateMotion, animateTransform, discard";
  var URL_ATTRS = /* @__PURE__ */ new Set([
    "href",
    "xlink:href",
    "src",
    "data",
    "poster"
  ]);
  var ALWAYS_STRIP_ATTRS = /* @__PURE__ */ new Set([
    "srcset",
    "ping",
    // form submission from an opened file is a top-level navigation that can
    // exfiltrate typed data — the form element itself is also removed, this
    // covers form-associated attributes on anything else.
    "action",
    "formaction",
    // a data:-href + download saves an attacker-authored file (e.g. a
    // scriptable .svg) from the opened export with one click
    "download",
    // legacy background attribute (body/table/td/tr) maps to background-image
    // and auto-fetches on open; no legitimate use in a diagram export.
    "background"
  ]);
  var PAINT_ATTRS = /* @__PURE__ */ new Set([
    "fill",
    "stroke",
    "filter",
    "mask",
    "clip-path",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor"
  ]);
  var AUTO_FETCH_ELEMENTS = /* @__PURE__ */ new Set([
    "image",
    "use",
    "feimage",
    "textpath",
    "lineargradient",
    "radialgradient",
    "pattern",
    "filter",
    "img",
    "source",
    "video",
    "audio",
    "track",
    "input"
  ]);
  var isFragmentOrDataImage = (raw) => {
    const v = raw.replace(/[\u0000-\u0020]/g, "");
    return v === "" || v.startsWith("#") || /^data:image\/(?!svg)/i.test(v);
  };
  var isSafeUrl = (raw) => {
    const v = raw.replace(/[\u0000-\u0020]/g, "");
    if (/^[/\\]{2}/.test(v)) {
      return false;
    }
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
    if (!m) {
      return true;
    }
    const scheme = m[1].toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
      return true;
    }
    return scheme === "data" && /^data:image\/(?!svg)/i.test(v);
  };
  var SAFE_PAINT_CHARS = /^[\s,a-z0-9#%.()/'"_\p{L}\p{M}-]*$/iu;
  var isSafePaintValue = (raw) => SAFE_PAINT_CHARS.test(raw) && !raw.includes("//") && // anchored so backtracking can't skip past whitespace: every url( must
  // open an (optionally quoted) fragment
  !/url\((?!\s*["']?#)/i.test(raw);
  var isDangerousStyleValue = (raw) => /url\s*\((?!\s*["']?(?:#|data:image\/(?!svg)))|image-set\s*\(|\\|\/\//i.test(
    raw
  );
  var scrubUrlAndHandlerAttrs = (rootEl) => {
    for (const el of Array.from(rootEl.querySelectorAll("*"))) {
      if (el.localName.includes(":")) {
        el.remove();
      }
    }
    const stack = [rootEl];
    while (stack.length) {
      const n = stack.pop();
      for (const child of Array.from(n.childNodes)) {
        if (child.nodeType === 8) {
          child.remove();
        } else {
          stack.push(child);
        }
      }
    }
    const isXmlName = (name) => /^[a-z_\p{L}][\w.:\p{L}\p{M}-]*$/iu.test(name);
    const isRefAttr = (name) => name === "href" || name === "xlink:href" || name === "src" || name === "poster";
    for (const el of [rootEl, ...rootEl.querySelectorAll("*")]) {
      const local = el.localName.toLowerCase();
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || !isXmlName(attr.name) || ALWAYS_STRIP_ATTRS.has(name) || attr.namespaceURI === null && name.includes(":") || // auto-fetch elements: reference must be fragment or data:image —
        // an https image in an opened file is a no-click beacon
        AUTO_FETCH_ELEMENTS.has(local) && isRefAttr(name) && !isFragmentOrDataImage(attr.value) || URL_ATTRS.has(name) && !isSafeUrl(attr.value)) {
          el.removeAttribute(attr.name);
        } else if (name === "style") {
          if (isDangerousStyleValue(attr.value)) {
            el.removeAttribute(attr.name);
          }
        } else if (PAINT_ATTRS.has(name) && !isSafePaintValue(attr.value)) {
          if (name === "cursor") {
            el.removeAttribute(attr.name);
          } else {
            el.setAttribute(attr.name, "none");
          }
        }
      }
    }
  };
  var hasUnrasterizableRef = (root4) => {
    const carriers = "image, use, feImage, textPath, linearGradient, radialGradient, pattern, filter, img, video, source";
    const refAttrs = ["href", "xlink:href", "src", "srcset", "poster"];
    for (const el of Array.from(root4.querySelectorAll(carriers))) {
      for (const name of refAttrs) {
        const ref = el.getAttribute(name);
        if (ref !== null && !isFragmentOrDataImage(ref)) {
          return true;
        }
      }
    }
    return false;
  };

  // src/scripts/sized-by-viewport.ts
  var CSS_VIEWPORT_UNITS = /\d\s*[dsl]?v(?:h|min|max)\b|\b(?:min-|max-)?h-(?:screen|[dsl]vh)\b|\b(?:min-)?vh-100\b/i;
  var CSS_HEIGHT_FROM_VIEWPORT = /(?:^|[^\w-])height\s*:\s*[^;}"']{0,80}?\d\s*[dsl]?vh\b|(?:^|[^\w-])h-(?:screen|[dsl]vh)\b|(?:^|[^\w-])vh-100\b/i;
  var READS_FRAME_HEIGHT = /\b(?:inner|window)Height\b|\bvisualViewport\b|\bscrollingElement\b|\b(?:documentElement|body)\.clientHeight\b/i;
  var fullHeightRule = (selector) => new RegExp(
    `(?:^|[\\s};>])${selector}\\s*\\{(?:[^{}]*[;\\s])?height\\s*:\\s*100%`,
    "i"
  );
  var HTML_AND_BODY_FULL = fullHeightRule(
    "(?:html\\s*,\\s*body|body\\s*,\\s*html)"
  );
  var HTML_FULL = fullHeightRule("html");
  var BODY_FULL = fullHeightRule("body");
  var withoutDataUrls = (code) => code.replace(/data:[^\s"'()]*/g, "");
  function htmlAndBodyFullHeight(code) {
    return HTML_AND_BODY_FULL.test(code) || HTML_FULL.test(code) && BODY_FULL.test(code);
  }
  function sizedByViewportInCss(code) {
    const css = withoutDataUrls(code);
    return CSS_VIEWPORT_UNITS.test(css) || htmlAndBodyFullHeight(css);
  }
  function heightFromViewportInCss(code) {
    const css = withoutDataUrls(code);
    return CSS_HEIGHT_FROM_VIEWPORT.test(css) || htmlAndBodyFullHeight(css);
  }
  function readsFrameHeight(code) {
    return READS_FRAME_HEIGHT.test(withoutDataUrls(code));
  }
  function sizedByViewport(code) {
    return sizedByViewportInCss(code) || readsFrameHeight(code);
  }

  // src/scripts/frame-sized.ts
  var EMPTY_MAX_HEIGHT = 8;
  var FRAME_SIZED_HEIGHT = 400;
  var EMPTY_REPORT_HEIGHT = EMPTY_MAX_HEIGHT + 1;
  var FRAME_WAIT_MS = 1e3;
  var FRAME_QUIET_MS = 150;
  var SCRIPTS_SETTLE_MS = 300;
  var LOWERED_RECHECK_MS = 1e3;
  var DRAW_WAIT_MS = 3e3;
  var INLINE_MODULE = /<script\b(?![^>]*\bsrc\s*=)[^>]*\btype\s*=\s*["']?module\b/i;
  var IMPORTS = /(?:^|[^@\w$.])import\s*[\s"'{*(]/;
  var READS_ELEMENT_HEIGHT = /\b(?:client|offset)Height\b|getBoundingClientRect\s*\(/;
  var DRAWS_ONCE = /<canvas|createElement\(\s*["'`]canvas|getContext\s*\(|WebGLRenderer|createCanvas\s*\(|\bPIXI\.|\bPhaser\.|\bKonva\.|\bPlotly\.|\becharts\.init/;
  var render = 0;
  var frameSized = false;
  var held;
  var emptyWatch;
  var settled;
  var shellElements;
  var drawnByScripts = false;
  var changedWithFrame = 0;
  var ratios = [];
  var bodyRatios = [];
  var lastBody = -1;
  var drewUnderHold = false;
  var emptySince = Infinity;
  var gaveUp = false;
  var newContent;
  var heldAgain = false;
  var emptying;
  var frameSettling;
  var heldBeforeScripts = false;
  var drawnAtSettle = -1;
  var moduleWaitUntil = -Infinity;
  var drawWaitUntil = Infinity;
  var ranInEmptyFrame = false;
  var last = { drawn: -1, frame: -1 };
  var heldAt = 0;
  var loweredFrom = 0;
  var loweredAt = -Infinity;
  var noLowering = false;
  var frameResized;
  var largerClosed;
  var frameStill;
  var frameMovedAt = -Infinity;
  var root = document.documentElement;
  function holdBodyAt(height) {
    heldAt = Math.ceil(height);
    root.style.setProperty("--frame-held", `${heldAt}px`);
    root.setAttribute("data-frame-held", "");
  }
  function fixedShareOver(shares) {
    return shares.length === 3 && Math.min(...shares) > 1.01 && Math.max(...shares) - Math.min(...shares) < 5e-3;
  }
  function capBodyAt(height) {
    root.style.setProperty("--frame-cap", `${Math.ceil(height)}px`);
    root.setAttribute("data-frame-capped", "");
  }
  function stopWatching() {
    held?.disconnect();
    held = void 0;
    largerClosed?.disconnect();
    largerClosed = void 0;
    if (frameResized) {
      window.removeEventListener("resize", frameResized);
      frameResized = void 0;
    }
    clearTimeout(frameStill);
  }
  function stopEmptying() {
    if (frameSettling) {
      window.removeEventListener("resize", frameSettling);
      frameSettling = void 0;
    }
    clearTimeout(emptying);
    root.removeAttribute("data-frame-empty");
    root.style.removeProperty("--frame-empty");
  }
  function release() {
    stopWatching();
    root.removeAttribute("data-frame-held");
    root.removeAttribute("data-frame-capped");
    root.style.removeProperty("--frame-held");
    root.style.removeProperty("--frame-cap");
    heldAt = 0;
  }
  function giveUp(visual2) {
    const id = render;
    gaveUp = true;
    release();
    stopEmptying();
    root.style.setProperty("--frame-empty", `${EMPTY_REPORT_HEIGHT}px`);
    root.setAttribute("data-frame-empty", "");
    frameSettling = () => {
      if (window.innerHeight <= EMPTY_REPORT_HEIGHT) {
        clearTimeout(emptying);
        emptying = setTimeout(stopEmptying, FRAME_QUIET_MS);
      }
    };
    window.addEventListener("resize", frameSettling);
    emptying = setTimeout(() => {
      root.removeAttribute("data-frame-empty");
      const copiesFrame = document.body.getBoundingClientRect().height >= window.innerHeight - 1;
      if (copiesFrame) {
        root.setAttribute("data-frame-empty", "");
      } else {
        stopEmptying();
      }
    }, DRAW_WAIT_MS);
    if (heldAgain || !frameSized) {
      return;
    }
    newContent = new MutationObserver((records) => {
      const added2 = records.some(
        (record) => [...record.addedNodes].some(
          (node) => node.nodeType === Node.ELEMENT_NODE
        )
      );
      if (!added2) {
        return;
      }
      newContent?.disconnect();
      stopEmptying();
      gaveUp = false;
      heldAgain = true;
      requestAnimationFrame(() => {
        const own = document.body.getBoundingClientRect().height;
        const frame = window.innerHeight;
        const empty = own <= EMPTY_MAX_HEIGHT && frame <= EMPTY_MAX_HEIGHT;
        const copiesFrame = frame > EMPTY_MAX_HEIGHT && Math.abs(own - frame) <= 1;
        if (id === render && !held && (empty || copiesFrame)) {
          hold(visual2);
        }
      });
    });
    newContent.observe(visual2, { childList: true, subtree: true });
  }
  function tallestCanvas() {
    let tallest = 0;
    for (const canvas of document.querySelectorAll("canvas")) {
      tallest = Math.max(tallest, canvas.getBoundingClientRect().height);
    }
    return tallest;
  }
  function drawnElsewhere(visual2) {
    let tallest = tallestCanvas();
    for (const element of document.body.children) {
      if (element === visual2 || shellElements?.has(element)) {
        continue;
      }
      const { position } = getComputedStyle(element);
      if (position !== "absolute" && position !== "fixed") {
        tallest = Math.max(tallest, element.getBoundingClientRect().height);
      }
    }
    return tallest;
  }
  function ownBodyHeight() {
    root.removeAttribute("data-frame-held");
    const height = document.body.getBoundingClientRect().height;
    root.setAttribute("data-frame-held", "");
    return height;
  }
  function fit(visual2) {
    const drawn = visual2.getBoundingClientRect().height;
    const frame = window.innerHeight;
    const body = document.body.getBoundingClientRect().height;
    const frameMoved = frame !== last.frame;
    if (root.hasAttribute("data-open-larger")) {
      last = { drawn, frame };
      lastBody = body;
      return;
    }
    if (drawnByScripts && frameMoved) {
      changedWithFrame = drawn !== last.drawn ? changedWithFrame + 1 : 0;
      ratios = drawn !== last.drawn && frame > EMPTY_MAX_HEIGHT ? [...ratios, drawn / frame].slice(-3) : [];
      bodyRatios = body !== lastBody && frame > EMPTY_MAX_HEIGHT ? [...bodyRatios, body / frame].slice(-3) : [];
    } else if (drawnByScripts && drawn !== last.drawn) {
      ratios = [];
      bodyRatios = [];
      if (drawn < last.drawn) {
        changedWithFrame = 0;
        noLowering = false;
      }
    }
    const shrankWithFrame = frameMoved && frame < last.frame && drawn < last.drawn;
    last = { drawn, frame };
    lastBody = body;
    if (!held || !drawnByScripts) {
      return;
    }
    const now = performance.now();
    if (loweredFrom > 0 && shrankWithFrame && changedWithFrame >= 2 && now - loweredAt < LOWERED_RECHECK_MS) {
      holdBodyAt(loweredFrom);
      loweredFrom = 0;
      noLowering = true;
      return;
    }
    const settledFrame = now - frameMovedAt >= FRAME_QUIET_MS;
    if (ranInEmptyFrame && now >= drawWaitUntil && frame > EMPTY_MAX_HEIGHT && tallestCanvas() <= EMPTY_MAX_HEIGHT) {
      giveUp(visual2);
      return;
    }
    if (drawn > EMPTY_MAX_HEIGHT) {
      drewUnderHold = true;
      emptySince = Infinity;
    } else if (frame > EMPTY_MAX_HEIGHT) {
      emptySince = Math.min(emptySince, now);
      const stillEmpty = now - emptySince >= FRAME_QUIET_MS;
      if (drewUnderHold && stillEmpty || !drewUnderHold && settledFrame && (!heldBeforeScripts || now >= drawWaitUntil && drawnElsewhere(visual2) <= EMPTY_MAX_HEIGHT)) {
        giveUp(visual2);
        return;
      }
      if (drewUnderHold) {
        const id = render;
        setTimeout(() => {
          if (id === render && held) {
            fit(visual2);
          }
        }, FRAME_QUIET_MS);
      }
    }
    if (!root.hasAttribute("data-frame-capped") && (fixedShareOver(ratios) || fixedShareOver(bodyRatios)) && ownBodyHeight() > frame + 1) {
      capBodyAt(Math.max(frame, heldAt));
      return;
    }
    if (settledFrame && changedWithFrame === 0 && drawn > frame + 1 && Math.ceil(drawn) > heldAt) {
      holdBodyAt(drawn);
      return;
    }
    if (!noLowering && settledFrame && changedWithFrame < 2 && drawn > EMPTY_MAX_HEIGHT && drawn < frame - 1 && (drawn !== drawnAtSettle || now >= moduleWaitUntil) && ownBodyHeight() < frame - 1 && Math.ceil(drawn) < heldAt) {
      if (loweredFrom === 0) {
        loweredFrom = heldAt;
        loweredAt = now;
      }
      holdBodyAt(drawn);
    }
  }
  function hold(visual2) {
    const id = render;
    stopEmptying();
    holdBodyAt(FRAME_SIZED_HEIGHT);
    changedWithFrame = 0;
    ratios = [];
    bodyRatios = [];
    lastBody = document.body.getBoundingClientRect().height;
    drewUnderHold = false;
    emptySince = Infinity;
    loweredFrom = 0;
    noLowering = false;
    frameMovedAt = performance.now();
    last = {
      drawn: visual2.getBoundingClientRect().height,
      frame: window.innerHeight
    };
    held = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (id === render) {
          fit(visual2);
        }
      });
    });
    held.observe(visual2);
    frameResized = () => {
      frameMovedAt = performance.now();
      requestAnimationFrame(() => {
        if (id === render) {
          fit(visual2);
        }
      });
      clearTimeout(frameStill);
      frameStill = setTimeout(() => {
        fit(visual2);
      }, FRAME_QUIET_MS);
    };
    window.addEventListener("resize", frameResized);
    largerClosed = new MutationObserver(() => {
      if (!root.hasAttribute("data-open-larger")) {
        frameMovedAt = performance.now();
        clearTimeout(frameStill);
        frameStill = setTimeout(() => {
          if (id === render) {
            fit(visual2);
          }
        }, FRAME_QUIET_MS);
      }
    });
    largerClosed.observe(root, { attributeFilter: ["data-open-larger"] });
    frameStill = setTimeout(() => {
      fit(visual2);
    }, FRAME_QUIET_MS);
  }
  function frameGrown() {
    return new Promise((resolve) => {
      let quiet;
      const done = () => {
        window.removeEventListener("resize", resized);
        clearTimeout(quiet);
        clearTimeout(cap);
        resolve();
      };
      const resized = () => {
        clearTimeout(quiet);
        if (window.innerHeight >= FRAME_SIZED_HEIGHT - 1) {
          done();
        } else if (window.innerHeight > EMPTY_MAX_HEIGHT) {
          quiet = setTimeout(done, FRAME_QUIET_MS);
        }
      };
      const cap = setTimeout(done, FRAME_WAIT_MS);
      window.addEventListener("resize", resized);
    });
  }
  async function holdFrameSizedVisual(code) {
    render++;
    release();
    emptyWatch?.disconnect();
    emptyWatch = void 0;
    newContent?.disconnect();
    newContent = void 0;
    stopEmptying();
    heldAgain = false;
    drawWaitUntil = Infinity;
    clearTimeout(settled);
    drawnByScripts = false;
    gaveUp = false;
    heldBeforeScripts = false;
    ranInEmptyFrame = false;
    drawnAtSettle = -1;
    moduleWaitUntil = -Infinity;
    frameMovedAt = -Infinity;
    const hostAllows = root.hasAttribute("data-hold-frame-sized");
    frameSized = hostAllows && sizedByViewportInCss(code);
    const visual2 = document.getElementById("vis-container");
    shellElements ?? (shellElements = new Set(document.body.children));
    if (visual2 && hostAllows && (readsFrameHeight(code) || heightFromViewportInCss(code) && READS_ELEMENT_HEIGHT.test(code)) && DRAWS_ONCE.test(code) && window.innerHeight <= EMPTY_MAX_HEIGHT) {
      hold(visual2);
      heldBeforeScripts = true;
      if (INLINE_MODULE.test(code) && IMPORTS.test(code)) {
        moduleWaitUntil = Infinity;
      }
      await frameGrown();
      ranInEmptyFrame = window.innerHeight <= EMPTY_MAX_HEIGHT;
    }
  }
  function scriptsRan() {
    clearTimeout(settled);
    settled = setTimeout(measureDrawn, SCRIPTS_SETTLE_MS);
  }
  function measureDrawn() {
    const id = render;
    drawnByScripts = true;
    const visual2 = document.getElementById("vis-container");
    if (!visual2) {
      return;
    }
    if (held) {
      if (heldBeforeScripts) {
        drawWaitUntil = performance.now() + DRAW_WAIT_MS;
        if (moduleWaitUntil === Infinity) {
          drawnAtSettle = visual2.getBoundingClientRect().height;
          moduleWaitUntil = drawWaitUntil;
        }
        settled = setTimeout(() => {
          drawWaitUntil = -Infinity;
          moduleWaitUntil = -Infinity;
          fit(visual2);
        }, DRAW_WAIT_MS);
      }
      fit(visual2);
    }
    if (!frameSized) {
      return;
    }
    emptyWatch = new ResizeObserver(() => {
      if (!held && !gaveUp && window.innerHeight <= EMPTY_MAX_HEIGHT && document.body.getBoundingClientRect().height <= EMPTY_MAX_HEIGHT) {
        requestAnimationFrame(() => {
          if (id === render && !held) {
            hold(visual2);
          }
        });
      }
    });
    emptyWatch.observe(document.body);
  }

  // src/scripts/hosted-copies.ts
  var MAP_DATA = /* @__PURE__ */ new Map([
    [
      "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
      "/libs/imagine/us-atlas-3.0.1/states-10m.json"
    ],
    [
      "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
      "/libs/imagine/world-atlas-2.0.2/countries-110m.json"
    ]
  ]);
  function fetchMapDataFromCopies(report) {
    if (typeof window.fetch !== "function") {
      return;
    }
    const cdnFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const [input, init] = args;
      const copy = typeof input === "string" || input instanceof URL ? MAP_DATA.get(String(input)) : void 0;
      if (copy === void 0) {
        return cdnFetch(...args);
      }
      return cdnFetch(copy, init).then((response) => {
        if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
          throw new Error(`${copy} answered ${response.status}`);
        }
        return response;
      }).catch((err) => {
        if (init?.signal?.aborted) {
          throw err;
        }
        report(copy);
        return cdnFetch(...args);
      });
    };
  }
  function switchToCdn(link, report) {
    const cdnHref = link.dataset.cdnHref;
    if (cdnHref === void 0) {
      return;
    }
    const copyHref = link.getAttribute("href") ?? "";
    delete link.dataset.cdnHref;
    link.href = cdnHref;
    report(copyHref);
  }
  function watchIconFont(report) {
    const link = document.getElementById("icon-font");
    if (!(link instanceof HTMLLinkElement)) {
      return;
    }
    if (link.hasAttribute("data-failed")) {
      switchToCdn(link, report);
      return;
    }
    link.addEventListener("error", () => switchToCdn(link, report), {
      once: true
    });
    const isIconFace = (face) => face.family.replace(/["']/g, "") === "tabler-icons";
    document.fonts?.addEventListener("loadingerror", (event) => {
      if (event.fontfaces.some(isIconFace)) {
        switchToCdn(link, report);
      }
    });
    const watchFaces = () => document.fonts?.forEach((face) => {
      if (isIconFace(face)) {
        face.loaded.catch(() => switchToCdn(link, report));
      }
    });
    watchFaces();
    link.addEventListener("load", watchFaces);
  }
  var MERMAID_IMPORT = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*(["'])https:\/\/(?:esm\.sh|cdn\.jsdelivr\.net\/npm)\/mermaid@11(?:\.\d+){0,2}\/dist\/mermaid\.esm(?:\.min)?\.mjs\2[ \t]*;?/;
  var MERMAID_COPY = "/libs/mermaid.min.js";
  var MERMAID_COPY_TIMEOUT_MS = 1e4;
  var mermaidCopy;
  function loadMermaidCopy() {
    mermaidCopy ?? (mermaidCopy = new Promise((resolve) => {
      const global = window;
      const before = global.mermaid;
      const script = document.createElement("script");
      script.src = MERMAID_COPY;
      const start = performance.now();
      const timer = setTimeout(
        () => resolve("hosted-copy-fallback:mermaid:timeout:big-file"),
        MERMAID_COPY_TIMEOUT_MS
      );
      script.onload = () => {
        clearTimeout(timer);
        const took = performance.now() - start;
        if (global.mermaid === before || typeof global.mermaid?.initialize !== "function") {
          resolve("hosted-copy-fallback:mermaid:error:big-file");
        } else if (took < 2e3) {
          resolve("hosted-copy-loaded:mermaid:under-2s:big-file");
        } else if (took < 5e3) {
          resolve("hosted-copy-loaded:mermaid:2-5s:big-file");
        } else {
          resolve("hosted-copy-loaded:mermaid:over-5s:big-file");
        }
      };
      script.onerror = () => {
        clearTimeout(timer);
        resolve("hosted-copy-fallback:mermaid:error:big-file");
      };
      document.head.append(script);
    }));
    return mermaidCopy;
  }
  function importsMermaid(code) {
    return MERMAID_IMPORT.test(code);
  }
  function preloadMermaidCopy(codes, report) {
    if (mermaidCopy === void 0 && codes.some(importsMermaid)) {
      void loadMermaidCopy().then((event) => report(event, MERMAID_COPY));
    }
  }
  async function importMermaidFromCopy(code) {
    if (!importsMermaid(code)) {
      return code;
    }
    if ((await loadMermaidCopy()).startsWith("hosted-copy-fallback:")) {
      return code;
    }
    return code.replace(
      new RegExp(MERMAID_IMPORT.source, "g"),
      (_, name) => `const ${name} = globalThis.mermaid;`
    );
  }

  // src/scripts/more-menu.ts
  function placeMoreMenu(group2, popover) {
    const items = [...popover.querySelectorAll(".more-item")];
    group2.removeAttribute("data-beside");
    for (const item of items) {
      item.style.width = "";
      item.removeAttribute("title");
    }
    const lowestItemBottom = group2.getBoundingClientRect().top + popover.offsetTop + popover.clientTop + Math.max(...items.map((item) => item.offsetTop + item.offsetHeight));
    const beside = lowestItemBottom > window.innerHeight;
    group2.toggleAttribute("data-beside", beside);
    if (!beside) {
      return;
    }
    for (const item of items) {
      const label = item.querySelector(".more-item-label");
      if (label && label.scrollWidth > label.clientWidth) {
        item.title = label.textContent ?? "";
      }
    }
    const widths = items.map((item) => item.getBoundingClientRect().width);
    for (const [i, item] of items.entries()) {
      if (!item.hidden) {
        item.style.width = `${Math.ceil(widths[i])}px`;
      }
    }
  }

  // src/scripts/send-prompt.ts
  var hostApp2 = app;
  var line = document.querySelector("#not-sent > p");
  var MOST_SHOWN = 300;
  var SHOWN_MARK = "data-not-sent";
  var hostHandlesNotSent = false;
  function readWhetherHostHandlesNotSent(result) {
    hostHandlesNotSent = result.hostContext?._hostHandlesNotSent === true;
  }
  function showNotSent(words) {
    const shown = line?.querySelector("q");
    if (!line || !shown) {
      return;
    }
    const characters = Array.from(words);
    shown.textContent = characters.length > MOST_SHOWN ? `${characters.slice(0, MOST_SHOWN).join("")}\u2026` : words;
    line.hidden = false;
    document.body.toggleAttribute(SHOWN_MARK, true);
  }
  var presses = 0;
  window.sendPrompt = function sendPrompt(text) {
    const words = navigator.userActivation?.isActive === true && !hostHandlesNotSent && typeof text === "string" ? text.trim() : "";
    const press = words ? ++presses : 0;
    const settle = (taken) => {
      if (press === 0 || press !== presses) {
        return;
      }
      if (!taken) {
        showNotSent(words);
      } else if (line) {
        line.hidden = true;
        document.body.toggleAttribute(SHOWN_MARK, false);
      }
    };
    let sent;
    try {
      sent = hostApp2.sendRequest({
        method: "ui/message",
        params: { role: "user", content: [{ type: "text", text }] }
      });
    } catch (thrown) {
      settle(false);
      throw thrown;
    }
    Promise.resolve(sent).then((answer) => answer.isError !== true).catch(() => false).then(settle);
  };

  // src/scripts/streaming-morph.ts
  var HOSTED_HELPERS = "/libs/imagine/streaming-helpers-1/streaming-helpers.mjs";
  async function importParserModules() {
    try {
      const hosted = await import(
        /* @vite-ignore */
        HOSTED_HELPERS
      );
      if (!["Parser", "DomHandler", "render", "morphdom"].every(
        (name) => typeof hosted[name] === "function"
      )) {
        throw new Error("the hosted streaming helpers are missing an export");
      }
      return {
        parser: {
          Parser: hosted.Parser,
          DomHandler: hosted.DomHandler,
          render: hosted.render
        },
        morphdom: hosted.morphdom
      };
    } catch (err) {
      console.warn(
        "[streaming] hosted helpers failed, loading them from esm.sh:",
        err
      );
      const [htmlparser2, domhandler, domSerializer, morphdom] = await Promise.all([
        import("https://esm.sh/htmlparser2@9.1.0"),
        import("https://esm.sh/domhandler@5.0.3"),
        import("https://esm.sh/dom-serializer@2.0.0"),
        import("https://esm.sh/morphdom@2.7.8")
      ]);
      return {
        parser: {
          Parser: htmlparser2.Parser,
          DomHandler: domhandler.DomHandler,
          render: domSerializer.default
        },
        morphdom: morphdom.default
      };
    }
  }
  function createStreamingRenderer2(options = {}) {
    const {
      stripScripts = false,
      widgetName = "Widget",
      shouldRender = () => true,
      onFirstRender
    } = options;
    let didFirstRender = false;
    const markFirstRender2 = () => {
      if (!didFirstRender) {
        didFirstRender = true;
        onFirstRender?.();
      }
    };
    let parserModules = null;
    let morphdomModule = null;
    let streamingParser = null;
    let prevCode = "";
    async function renderPartial(container3, code) {
      if (!code) {
        return;
      }
      if (!parserModules || !morphdomModule) {
        try {
          const loaded = await importParserModules();
          parserModules = loaded.parser;
          morphdomModule = loaded.morphdom;
        } catch (err) {
          console.warn(
            `[${widgetName}] could not load the streaming helpers, falling back to innerHTML:`,
            err
          );
          if (shouldRender(code)) {
            container3.innerHTML = code;
            markFirstRender2();
          }
          return;
        }
      }
      if (code.length < prevCode.length || !streamingParser) {
        const handler = new parserModules.DomHandler();
        streamingParser = {
          parser: new parserModules.Parser(handler, {
            decodeEntities: false,
            lowerCaseAttributeNames: false,
            lowerCaseTags: false,
            recognizeSelfClosing: true
          }),
          handler,
          write(chunk) {
            this.parser.write(chunk);
          },
          serialize() {
            return parserModules.render(this.handler.root.children, {
              encodeEntities: false
            });
          }
        };
        prevCode = "";
      }
      const newChunk = code.substring(prevCode.length);
      if (newChunk) {
        streamingParser.write(newChunk);
        prevCode = code;
      }
      let serialized = streamingParser.serialize();
      if (serialized) {
        if (stripScripts) {
          serialized = serialized.replace(/<script[\s\S]*?<\/script>/gi, "");
        }
        if (shouldRender(serialized)) {
          const tempContainer = container3.cloneNode(false);
          tempContainer.innerHTML = serialized;
          morphdomModule(container3, tempContainer, { childrenOnly: true });
          markFirstRender2();
        }
      }
    }
    return { renderPartial };
  }
  window.createStreamingRenderer = createStreamingRenderer2;

  // src/scripts/chart-text-size.ts
  var chartFontSizes = /* @__PURE__ */ new WeakMap();
  var DEFAULT_TEXT_XS_PX = 12;
  var LEVEL_LABELS_ONCE_DROPPING = false;
  var SCALE_KEY_SQUARE_WIDTH = false;
  var MIN_WIDTH_WORTH_FITTING = 50;
  var MIN_DRAWN_WIDTH_SHARE = 0.35;
  var chartFits = /* @__PURE__ */ new WeakMap();
  var heightsLeft = /* @__PURE__ */ new WeakMap();
  var boxesGrown = /* @__PURE__ */ new WeakSet();
  var boxesTheVisualsOwn = /* @__PURE__ */ new WeakSet();
  var chartsJustMade = /* @__PURE__ */ new WeakSet();
  var fittingChart;
  var chartsPassedOver = [];
  function chartTextFollowsHost(hostTextXsSize, on) {
    const chartJs = window.Chart;
    const defaults = chartJs?.defaults;
    const font = defaults?.font;
    if (!chartJs || !defaults || !font || typeof font.size !== "number") {
      return;
    }
    let sizes = chartFontSizes.get(defaults);
    if (!sizes && !on) {
      return;
    }
    if (!sizes) {
      sizes = watchCharts(chartJs, font.size);
      chartFontSizes.set(defaults, sizes);
    }
    sizes.usePageFont();
    if (font.size !== sizes.lastWritten) {
      return;
    }
    const hostXs = on ? /^(\d+(?:\.\d+)?)px$/.exec(hostTextXsSize ?? "") : null;
    sizes.scale = hostXs ? Number(hostXs[1]) / DEFAULT_TEXT_XS_PX : 1;
    sizes.lastWritten = sizes.cameWith * sizes.scale;
    if (font.size === sizes.lastWritten) {
      return;
    }
    font.size = sizes.lastWritten;
    for (const chart of Object.values(chartJs.instances ?? {})) {
      try {
        chart.update("none");
      } catch {
        takeOutAll();
      }
    }
  }
  function watchCharts(chartJs, cameWith) {
    const fontNow = () => chartJs.defaults?.font;
    let swapped;
    const setGaps = keyAndTitleGaps(chartJs);
    const record = {
      cameWith,
      lastWritten: cameWith,
      scale: 1,
      useChartFont: (chart) => {
        record.usePageFont();
        const font = fontNow();
        if (font && font.size === record.lastWritten) {
          swapped = font;
          const scale = chartFits.get(chart)?.scale ?? record.scale;
          font.size = cameWith * scale;
          const follows = (size) => size === void 0 || size === font.size;
          setGaps(
            Math.max(1, scale),
            follows(chart.legend?.options?.labels?.font?.size),
            follows(chart.options?.plugins?.title?.font?.size)
          );
          keepKeyClearOfAxis(
            chart,
            fontNow,
            cameWith,
            scale > 1 && Object.values(chart.options?.scales ?? {}).some(
              (axis) => follows(axis?.ticks?.font?.size)
            )
          );
        }
      },
      pageWidePadding: () => chartJs.defaults?.layout?.padding,
      usePageFont: () => {
        if (swapped) {
          swapped.size = record.lastWritten;
          swapped = void 0;
          setGaps(1, true, true);
        }
      }
    };
    const guarded = (hook) => (chart) => {
      try {
        hook(chart);
      } catch {
      }
    };
    try {
      chartJs.register?.({
        id: "imagineTextSize",
        beforeInit: guarded((chart) => {
          chartsJustMade.add(chart);
          if (record.scale !== 1 && !growableShape(chart)) {
            chartFits.set(chart, leftAloneFit());
            const box = chart.canvas?.parentElement;
            if (box) {
              giveBoxBack(box);
            }
          }
        }),
        beforeDestroy: guarded(takeOutChartOptions),
        beforeUpdate: guarded((chart) => {
          record.useChartFont(chart);
          putInChartOptions(chart, record);
        }),
        afterUpdate: guarded((chart) => {
          takeOutChartOptions(chart);
          record.usePageFont();
          const justMade = chartsJustMade.delete(chart);
          if (fontNow()?.size === record.lastWritten) {
            fitChart(chart, record, justMade);
          }
        }),
        // While any chart is being fitted, no chart renders: no drawing, no animation starting, no
        // onComplete. The fit itself stops a chart (which may call its onComplete) and draws it once.
        beforeRender: () => !fittingChart,
        beforeDraw: guarded(record.useChartFont),
        afterDraw: guarded(record.usePageFont),
        beforeEvent: guarded(record.useChartFont),
        afterEvent: guarded(record.usePageFont)
      });
    } catch {
    }
    return record;
  }
  function keyAndTitleGaps(chartJs) {
    const labels = chartJs.defaults?.plugins?.legend?.labels;
    const title = chartJs.defaults?.plugins?.title;
    const gaps = [];
    for (const [on, name] of [
      [labels, "padding"],
      [title, "padding"],
      [SCALE_KEY_SQUARE_WIDTH ? labels : void 0, "boxWidth"]
    ]) {
      const value = on?.[name];
      if (on && typeof value === "number") {
        gaps.push({
          on,
          name,
          cameWith: value,
          lastWritten: value,
          ofTheKey: on === labels
        });
      }
    }
    return (scale, keyFollows, titleFollows) => {
      for (const gap of gaps) {
        if (gap.on[gap.name] === gap.lastWritten) {
          const follows = gap.ofTheKey ? keyFollows : titleFollows;
          gap.lastWritten = gap.cameWith * (follows ? scale : 1);
          gap.on[gap.name] = gap.lastWritten;
        }
      }
    };
  }
  var keysMadeTaller = /* @__PURE__ */ new WeakMap();
  function keepKeyClearOfAxis(chart, fontNow, cameWith, axisTextFollows) {
    const key = chart.legend;
    if (!key?.fit) {
      return;
    }
    const made = keysMadeTaller.get(key);
    if (made || !axisTextFollows) {
      if (made) {
        made.axisTextFollows = axisTextFollows;
      }
      return;
    }
    const now = { axisTextFollows };
    keysMadeTaller.set(key, now);
    const fit2 = key.fit.bind(key);
    key.fit = () => {
      fit2();
      const position = key.options?.position;
      if (now.axisTextFollows && typeof key.height === "number" && (position === void 0 || position === "top")) {
        key.height += Math.max(0, Number(fontNow()?.size) - cameWith || 0) * 0.6;
      }
    };
  }
  function measureLabels(chart) {
    const ctx = chart.ctx;
    const found = {
      overlap: false,
      offLeft: -Infinity,
      offRight: -Infinity,
      roomLeft: -Infinity,
      roomRight: -Infinity
    };
    if (!ctx) {
      return found;
    }
    for (const scale of Object.values(chart.scales ?? {})) {
      if (scale.options?.display === false || scale.options?.ticks?.display === false) {
        continue;
      }
      let previous;
      for (const item of scale.getLabelItems?.() ?? []) {
        const lines = Array.isArray(item.label) ? item.label : [item.label];
        ctx.save();
        ctx.font = item.font.string;
        const width = Math.max(
          ...lines.map((line2) => ctx.measureText(String(line2)).width)
        );
        ctx.restore();
        const height = item.font.size + (lines.length - 1) * (item.font.lineHeight ?? item.font.size);
        const { rotation, textAlign, translation } = item.options ?? item;
        if (rotation === void 0 || !translation) {
          continue;
        }
        const start = textAlign === "center" ? -width / 2 : textAlign === "right" ? -width : 0;
        const along = translation[0] * Math.cos(rotation) + translation[1] * Math.sin(rotation);
        const across = translation[1] * Math.cos(rotation) - translation[0] * Math.sin(rotation);
        const box = {
          x0: along + start,
          x1: along + start + width,
          y0: across - item.font.size / 2,
          y1: across - item.font.size / 2 + height
        };
        found.overlap || (found.overlap = !!previous && box.x0 < previous.x1 && previous.x0 < box.x1 && box.y0 < previous.y1 && previous.y0 < box.y1);
        previous = box;
        const ends = [start, start + width].map(
          (x) => translation[0] + x * Math.cos(rotation)
        );
        const [left, right] = [
          -Math.min(...ends),
          Math.max(...ends) - (chart.width ?? Infinity)
        ];
        found.offLeft = Math.max(found.offLeft, left);
        found.offRight = Math.max(found.offRight, right);
        if (scale.isHorizontal?.()) {
          found.roomLeft = Math.max(found.roomLeft, left);
          found.roomRight = Math.max(found.roomRight, right);
        }
      }
    }
    return found;
  }
  function labelsFit(chart) {
    const { overlap, offLeft, offRight } = measureLabels(chart);
    return !overlap && offLeft <= 1 && offRight <= 1;
  }
  function marginOfTheLibrarysOwn(chart, side, paddingThere) {
    const area = chart.chartArea;
    if (!area) {
      return 0;
    }
    const axes = Object.values(chart.scales ?? {}).reduce(
      (sum, axis) => sum + (axis.position === side && axis.options?.display !== false ? axis.width ?? 0 : 0),
      0
    );
    const margin = side === "left" ? area.left : (chart.width ?? 0) - area.right;
    return Math.max(0, margin - paddingThere - axes);
  }
  function keyFits(chart) {
    const key = chart.legend;
    if (!key || key.options?.display === false) {
      return true;
    }
    const sideways = key.options?.position === "left" || key.options?.position === "right";
    const [size, limit] = sideways ? [key.width, key.maxWidth] : [key.height, key.maxHeight];
    return !(size && limit && size >= limit);
  }
  function chartFitsItsBox(chart) {
    const area = chart.chartArea;
    if (!area || !chart.width) {
      return true;
    }
    return area.right - area.left >= MIN_DRAWN_WIDTH_SHARE * chart.width && keyFits(chart) && labelsFit(chart) && !barNamesDropped(chart);
  }
  var barNamesAtDefault = /* @__PURE__ */ new WeakMap();
  function barNames(chart) {
    const axis = Object.values(chart.scales ?? {}).find(
      (scale) => scale.axis === "y" && scale.type === "category"
    );
    return chart.options?.indexAxis === "y" && axis ? [axis.ticks?.length ?? 0, `${axis.min}:${axis.max}`] : void 0;
  }
  function barNamesDropped(chart) {
    const now = barNames(chart);
    const atDefault = barNamesAtDefault.get(chart);
    return !!now && !!atDefault && (now[1] !== atDefault[1] || now[0] < atDefault[0]);
  }
  function growableShape(chart) {
    const box = chart.canvas?.parentElement;
    const kinds = [
      chart.config?.type,
      ...(chart.config?.data?.datasets ?? []).map((dataset) => dataset?.type)
    ];
    if (!box || boxesTheVisualsOwn.has(box) || kinds.some((kind) => kind === "radar" || kind === "polarArea") || !growableBox(chart, heightRewritten(box)) || heightAnimates(box)) {
      return void 0;
    }
    return box;
  }
  function heightRewritten(box) {
    return heightsLeft.has(box) && box.style.height !== heightsLeft.get(box);
  }
  function leftAloneFit() {
    return {
      scale: 1,
      fittedFor: "",
      fitted: true,
      dropping: [],
      padding: void 0,
      leftAlone: true
    };
  }
  function resizeToBox(chart) {
    const box = chart.canvas?.parentElement;
    if (!box?.offsetWidth || !box.clientWidth || Math.abs(box.getBoundingClientRect().width - box.offsetWidth) < 1) {
      chart.resize?.();
      return;
    }
    const style = getComputedStyle(box);
    const px2 = (property) => parseFloat(style.getPropertyValue(property)) || 0;
    const edges = (start, end, laidOut) => {
      if (style.boxSizing !== "border-box") {
        return 0;
      }
      const border = px2(`border-${start}-width`) + px2(`border-${end}-width`);
      return px2(`padding-${start}`) + px2(`padding-${end}`) + (Math.abs(border - laidOut) < 1 ? border : laidOut);
    };
    const width = px2("width") - edges("left", "right", box.offsetWidth - box.clientWidth);
    const height = px2("height") - edges("top", "bottom", box.offsetHeight - box.clientHeight);
    if (width <= 0 || height <= 0) {
      chart.resize?.();
    } else {
      chart.resize?.(width, height);
    }
  }
  function putBack(chart, kept) {
    Object.assign(kept, leftAloneFit());
    try {
      chart.stop?.();
    } catch {
    }
    try {
      const box = chart.canvas?.parentElement;
      if (box && giveBoxBack(box)) {
        resizeToBox(chart);
      }
      chart.update("none");
    } catch {
    }
  }
  function giveBoxBack(box) {
    const written = box.dataset.imagineChartBoxHeight;
    if (!boxesGrown.has(box) || written === void 0 || box.style.height !== heightsLeft.get(box)) {
      return false;
    }
    box.style.height = written;
    heightsLeft.set(box, written);
    boxesGrown.delete(box);
    return true;
  }
  function growableBox(chart, heightRewritten2) {
    const box = chart.canvas?.parentElement;
    const inFlow = [...box?.children ?? []].filter(
      (el) => !["absolute", "fixed"].includes(getComputedStyle(el).position)
    );
    if (!box || chart.options?.responsive === false || chart.options?.maintainAspectRatio !== false || inFlow.length !== 1 || inFlow[0] !== chart.canvas) {
      return void 0;
    }
    if (box.dataset.imagineChartBoxHeight === void 0 || heightRewritten2) {
      box.dataset.imagineChartBoxHeight = box.style.height;
    }
    return /^\d+(?:\.\d+)?px$/.test(box.dataset.imagineChartBoxHeight) ? box : void 0;
  }
  function ancestorsOf(box) {
    const found = [];
    for (let el = box.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      found.push([el, overflowNow(el)]);
    }
    return found;
  }
  function overflowNow(el) {
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }
  function followersOf(box) {
    const found = [];
    for (let el = box; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      for (let next = el.nextElementSibling; next; next = next.nextElementSibling) {
        if (!["absolute", "fixed", "sticky"].includes(
          getComputedStyle(next).position
        )) {
          found.push([next, overlapWith(box, next)]);
        }
      }
    }
    return found;
  }
  function overlapWith(box, other) {
    const a = box.getBoundingClientRect();
    const b = other.getBoundingClientRect();
    const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return across > 0.5 ? Math.max(0, down) : 0;
  }
  function pageTookIt(box, before, height) {
    if (before.laidOut > 0 && box.offsetHeight < height - 1) {
      return false;
    }
    return before.ancestors.every(([el, was]) => overflowNow(el) - was <= 1) && before.followers.every(([el, was]) => overlapWith(box, el) - was <= 1);
  }
  function sidesOf(padding) {
    const sides = padding;
    const each = (side, axis) => typeof padding === "number" ? padding : Number(sides?.[side] !== void 0 ? sides[side] : sides?.[axis]) || 0;
    return {
      top: each("top", "y"),
      right: each("right", "x"),
      bottom: each("bottom", "y"),
      left: each("left", "x")
    };
  }
  var openUpdates = [];
  function takeOut(open) {
    for (const undo of open.undo.splice(0).reverse()) {
      undo();
    }
  }
  function setFor(undo, find, key, value) {
    const on = find();
    if (!on) {
      return;
    }
    const had = key in on;
    const was = on[key];
    undo.push(() => {
      const now = find();
      if (now && had) {
        now[key] = was;
      } else if (now) {
        delete now[key];
      }
    });
    on[key] = value;
  }
  function paddingStood(chart, record) {
    const layout = chart.config?.options?.layout;
    const own = layout && "padding" in layout ? layout.padding : void 0;
    const pageWide = record.pageWidePadding();
    const padding = own === void 0 ? pageWide : own;
    if (typeof padding === "function") {
      return void 0;
    }
    const isObject = (value) => typeof value === "object" && value !== null;
    return sidesOf(
      isObject(own) && isObject(pageWide) ? { ...pageWide, ...own } : padding
    );
  }
  function putInChartOptions(chart, record) {
    const kept = chartFits.get(chart);
    const options = () => chart.config?.options;
    const outer = openUpdates[openUpdates.length - 1];
    if (outer) {
      takeOut(outer);
    } else if (!kept || !options()) {
      return;
    }
    const ticksOf = (id) => () => options()?.scales?.[id]?.ticks;
    if (kept) {
      kept.dropping = kept.dropping.filter(
        (id) => ticksOf(id)()?.autoSkip === false
      );
    }
    if (kept?.padding) {
      const stood = paddingStood(chart, record);
      if (!stood || JSON.stringify(stood) !== kept.padding.stood) {
        kept.padding = void 0;
        kept.fittedFor = "";
      }
    }
    const dropping = kept?.dropping ?? [];
    const padding = kept?.padding;
    const put = () => {
      const undo = [];
      for (const id of dropping) {
        setFor(undo, ticksOf(id), "autoSkip", true);
        if (LEVEL_LABELS_ONCE_DROPPING) {
          setFor(undo, ticksOf(id), "maxRotation", 0);
        }
      }
      if (padding) {
        if (!options()?.layout) {
          setFor(undo, options, "layout", {});
        }
        setFor(undo, () => options()?.layout, "padding", padding.sides);
      }
      return undo;
    };
    openUpdates.push({ chart, put, undo: put() });
    void Promise.resolve().then(takeOutAll);
  }
  function takeOutChartOptions(chart) {
    const at = openUpdates.findIndex((open) => open.chart === chart);
    if (at < 0) {
      return;
    }
    for (const open of openUpdates.splice(at).reverse()) {
      takeOut(open);
    }
    const outer = openUpdates[openUpdates.length - 1];
    if (outer && !outer.undo.length) {
      outer.undo = outer.put();
    }
  }
  function takeOutAll() {
    for (const open of openUpdates.splice(0).reverse()) {
      takeOut(open);
    }
  }
  function heightAnimates(box) {
    const style = getComputedStyle(box);
    const durations = style.transitionDuration.split(",");
    return style.transitionProperty.split(",").some(
      (property, i) => ["all", "height"].includes(property.trim()) && parseFloat(durations[i % durations.length]) > 0
    );
  }
  function fitChart(chart, record, justMade = false) {
    if (fittingChart) {
      if (chart !== fittingChart && !chartsPassedOver.includes(chart)) {
        chartsPassedOver.push(chart);
      }
      return;
    }
    const asked = record.scale;
    const fittedForNow = () => `${chart.width}@${asked}`;
    let fit2 = chartFits.get(chart);
    if (!fit2) {
      if (asked === 1 || asked < 1 && growableShape(chart)) {
        return;
      }
      fit2 = { scale: asked, fittedFor: "", fitted: true, dropping: [] };
      chartFits.set(chart, fit2);
    }
    const kept = fit2;
    if (kept.leftAlone) {
      return;
    }
    const drawnHeight = () => chart.chartArea ? chart.chartArea.bottom - chart.chartArea.top : 0;
    const withChartFont = (measure) => {
      record.useChartFont(chart);
      try {
        return measure(chart);
      } finally {
        record.usePageFont();
      }
    };
    const fitsNow = () => withChartFont(chartFitsItsBox);
    const boxNow = chart.canvas?.parentElement;
    const rewritten = !!boxNow && heightRewritten(boxNow);
    if (boxNow && rewritten && boxesGrown.has(boxNow)) {
      boxesTheVisualsOwn.add(boxNow);
    }
    const box = growableShape(chart);
    if (!box) {
      putBack(chart, kept);
      return;
    }
    if (!chart.width || chart.width < MIN_WIDTH_WORTH_FITTING) {
      return;
    }
    if (kept.fittedFor === fittedForNow() && (!kept.fitted || fitsNow() && (kept.drawnHeightLeft === void 0 || Math.abs(kept.drawnHeightLeft - drawnHeight()) <= 2))) {
      return;
    }
    kept.fittedFor = "";
    fittingChart = chart;
    const cutOff = new Error("cut off");
    try {
      const stopNow = () => {
        try {
          chart.stop?.();
        } catch {
        }
      };
      if (!justMade) {
        stopNow();
        chart.draw?.();
      }
      const resizeNow = () => {
        if (!justMade) {
          stopNow();
        }
        resizeToBox(chart);
      };
      kept.dropping = [];
      const written = parseFloat(box.dataset.imagineChartBoxHeight ?? "");
      let drawnHeightAtDefault;
      const growBox = () => {
        if (drawnHeightAtDefault === void 0) {
          return;
        }
        for (let pass = 0; pass < 2; pass++) {
          const short = drawnHeightAtDefault - drawnHeight();
          const before = parseFloat(box.style.height);
          const height = Math.max(written, before + short);
          if (Math.abs(height - before) <= 1) {
            break;
          }
          const onThePage = {
            laidOut: box.offsetHeight,
            ancestors: ancestorsOf(box),
            followers: followersOf(box)
          };
          box.style.height = `${height}px`;
          resizeNow();
          if (height > before && !pageTookIt(box, onThePage, height)) {
            throw cutOff;
          }
          chart.update("none");
        }
      };
      const layOutAt = (scale) => {
        kept.scale = scale;
        let left = 0;
        let right = 0;
        const stoodOrNone = paddingStood(chart, record);
        const canWrite = !!stoodOrNone;
        const stood = stoodOrNone ?? sidesOf(0);
        kept.padding = void 0;
        box.style.height = `${written}px`;
        resizeNow();
        chart.update("none");
        growBox();
        for (let pass = 0; canWrite && scale > 1 && pass < 3; pass++) {
          const { roomLeft, roomRight } = withChartFont(measureLabels);
          const beyond = (side, off, added2) => off > 1 ? marginOfTheLibrarysOwn(chart, side, stood[side] + added2) : 0;
          const nextLeft = Math.max(
            0,
            left + roomLeft + beyond("left", roomLeft, left)
          );
          const nextRight = Math.max(
            0,
            right + roomRight + beyond("right", roomRight, right)
          );
          if (Math.abs(nextLeft - left) <= 1 && Math.abs(nextRight - right) <= 1) {
            break;
          }
          left = nextLeft;
          right = nextRight;
          kept.padding = {
            sides: {
              ...stood,
              left: stood.left + left,
              right: stood.right + right
            },
            stood: JSON.stringify(stood)
          };
          chart.update("none");
          growBox();
        }
        kept.fitted = fitsNow();
        return kept.fitted;
      };
      const fitAtLargestSize = () => {
        let done = layOutAt(asked) || asked <= 1;
        const axes = chart.config?.options?.scales ?? {};
        for (const [id, axis] of done ? [] : Object.entries(axes)) {
          if (axis?.ticks?.autoSkip === false) {
            kept.dropping.push(id);
          }
        }
        done || (done = kept.dropping.length > 0 && layOutAt(asked));
        let fits = 1;
        let tooLarge = asked;
        for (let step = 0; !done && step < 5; step++) {
          const middle = (fits + tooLarge) / 2;
          if (layOutAt(middle)) {
            fits = middle;
          } else {
            tooLarge = middle;
          }
        }
        if (!done) {
          if (fits === 1) {
            kept.dropping = [];
          }
          layOutAt(fits);
        }
      };
      try {
        if (asked > 1) {
          layOutAt(1);
          drawnHeightAtDefault = drawnHeight();
          const names = barNames(chart);
          if (names !== void 0) {
            barNamesAtDefault.set(chart, names);
          }
        }
        fitAtLargestSize();
      } catch (error) {
        if (error !== cutOff) {
          throw error;
        }
        box.style.height = `${written}px`;
        resizeNow();
        putBack(chart, kept);
      }
      if (justMade && chart.options?.animation !== false) {
        chart.reset?.();
        chart.update();
      }
      kept.drawnHeightLeft = drawnHeight();
      kept.fittedFor = fittedForNow();
    } catch {
      kept.fitted = false;
      kept.fittedFor = fittedForNow();
    } finally {
      fittingChart = void 0;
      takeOutChartOptions(chart);
      record.usePageFont();
      heightsLeft.set(box, box.style.height);
      if (box.style.height !== box.dataset.imagineChartBoxHeight) {
        boxesGrown.add(box);
      } else {
        boxesGrown.delete(box);
      }
    }
    for (const passedOver of chartsPassedOver.splice(0)) {
      try {
        passedOver.update("none");
      } catch {
      }
    }
  }

  // src/scripts/host-display.ts
  var display = {
    displayMode: "inline",
    availableDisplayModes: [],
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    platform: void 0
  };
  var displayModeChanges = 0;
  var listeners = /* @__PURE__ */ new Set();
  function hostDisplay() {
    return display;
  }
  function onHostDisplayChange(listener) {
    listeners.add(listener);
  }
  function displayModeChangeCount() {
    return displayModeChanges;
  }
  function tellListeners(context) {
    for (const listener of listeners) {
      try {
        listener(context);
      } catch {
      }
    }
  }
  function setDisplayMode(mode) {
    if (mode !== display.displayMode) {
      displayModeChanges++;
      display.displayMode = mode;
    }
  }
  function insetOf(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }
  function readHostDisplay(context) {
    if (!context || typeof context !== "object") {
      return;
    }
    const members = context;
    if (typeof members.platform === "string") {
      display.platform = members.platform;
    }
    if (Array.isArray(members.availableDisplayModes)) {
      display.availableDisplayModes = members.availableDisplayModes.filter(
        (mode) => typeof mode === "string"
      );
    }
    const insets = members.safeAreaInsets;
    if (insets && typeof insets === "object") {
      const sent = insets;
      display.safeAreaInsets = {
        top: insetOf(sent.top),
        right: insetOf(sent.right),
        bottom: insetOf(sent.bottom),
        left: insetOf(sent.left)
      };
    }
    if (typeof members.displayMode === "string") {
      setDisplayMode(members.displayMode);
    }
    tellListeners(members);
  }
  function takeDisplayMode(mode) {
    setDisplayMode(mode);
    tellListeners({});
  }

  // src/scripts/host-init.ts
  function applyHostTheme(theme) {
    if (printing) {
      if (theme !== null && theme !== void 0) {
        deferredTheme = theme;
      }
      return;
    }
    const root4 = document.documentElement;
    if (theme === "light" || theme === "dark") {
      root4.setAttribute("data-mode", theme);
      root4.style.colorScheme = theme;
    } else if (theme !== null && theme !== void 0) {
      root4.removeAttribute("data-mode");
      root4.style.removeProperty("color-scheme");
    }
  }
  function initHostContext2(result) {
    const hostContext = result.hostContext;
    if (!hostContext) {
      return;
    }
    applyHostTheme(hostContext.theme);
    applyHostStrings(hostContext._hostStrings);
    applyChartsFollowTextSize(hostContext._chartsFollowTextSize);
    applyScrollWide(hostContext._scrollWide);
    applyKeepMenuClear(hostContext._keepMenuClear);
    applyHoldFrameSized(hostContext._holdFrameSized);
    readHostDisplay(hostContext);
    document.documentElement.toggleAttribute(
      "data-center-content",
      hostContext._centerContent === true
    );
    const styles = hostContext.styles;
    if (!styles) {
      return;
    }
    const css = styles.css;
    if (css?.fonts) {
      const fontStyle = document.getElementById("mcp-host-fonts");
      if (fontStyle) {
        fontStyle.textContent = css.fonts;
      }
    }
    applyHostVariables(styles.variables);
  }
  var hostVariables = /* @__PURE__ */ new Map();
  var CUSTOM_PROPERTY_NAME = /^--[\w-]+$/;
  var BREAKS_OUT_OF_DECLARATION = /[;{}\\\n\r\f]|\/\*/;
  var FONT_SIZE_VARIABLE = /^--font-(?:text|heading)-[a-z0-9]+-size$/;
  function fontSizesOnly(variables) {
    if (!variables || typeof variables !== "object") {
      return void 0;
    }
    const sizes = Object.entries(variables).filter(
      ([name]) => FONT_SIZE_VARIABLE.test(name)
    );
    return sizes.length > 0 ? Object.fromEntries(sizes) : void 0;
  }
  function applyHostVariables(variables) {
    if (!variables || typeof variables !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === "string" && CUSTOM_PROPERTY_NAME.test(key) && !BREAKS_OUT_OF_DECLARATION.test(value)) {
        hostVariables.set(key, value);
      }
    }
    let style = document.getElementById("mcp-host-variables");
    if (!style) {
      style = document.createElement("style");
      style.id = "mcp-host-variables";
      document.head.appendChild(style);
    }
    const css = ":root {\n" + [...hostVariables].map(([key, value]) => "  " + key + ": " + value + ";").join("\n") + "\n}";
    if (style.textContent !== css) {
      style.textContent = css;
    }
  }
  function applyScrollWide(value) {
    if (typeof value === "boolean") {
      document.documentElement.toggleAttribute("data-scroll-wide", value);
    }
  }
  function applyKeepMenuClear(value) {
    if (typeof value === "boolean") {
      document.documentElement.toggleAttribute("data-keep-menu-clear", value);
    }
  }
  function applyHoldFrameSized(value) {
    if (typeof value === "boolean") {
      document.documentElement.toggleAttribute("data-hold-frame-sized", value);
    }
  }
  var chartsFollowTextSize = false;
  function applyChartsFollowTextSize(value) {
    if (typeof value === "boolean") {
      chartsFollowTextSize = value;
    }
  }
  function applyHostTextSizeToCharts2() {
    chartTextFollowsHost(
      hostVariables.get("--font-text-xs-size"),
      chartsFollowTextSize
    );
  }
  function applyHostStrings(hostStrings) {
    if (!hostStrings || typeof hostStrings !== "object") {
      return;
    }
    const strings = hostStrings;
    const sent = (key) => {
      const val = key ? strings[key] : void 0;
      return typeof val === "string" && val.trim() ? val : void 0;
    };
    const tagged = (attribute) => document.querySelectorAll(
      `body > #action-btns [${attribute}], body > #not-sent [${attribute}], body > #larger-btns [${attribute}]`
    );
    tagged("data-i18n").forEach((el) => {
      const val = sent(el.dataset.i18n);
      if (val) {
        el.textContent = val;
      }
    });
    tagged("data-i18n-aria-label").forEach((el) => {
      const val = sent(el.dataset.i18nAriaLabel);
      if (val) {
        el.setAttribute("aria-label", val);
      }
    });
    window.__hostStrings = strings;
  }
  var printing = false;
  var deferredTheme;
  window.addEventListener("beforeprint", () => {
    printing = true;
  });
  window.addEventListener("afterprint", () => {
    printing = false;
    if (deferredTheme !== void 0) {
      const theme = deferredTheme;
      deferredTheme = void 0;
      applyHostTheme(theme);
    }
  });
  window.addEventListener("message", (event) => {
    if (event.source !== proxyPage) {
      return;
    }
    const data = event.data;
    if (data?.method === "ui/notifications/host-context-changed") {
      applyHostTheme(data.params?.theme);
      const styles = data.params?.styles;
      applyHostVariables(fontSizesOnly(styles?.variables));
      applyHostStrings(data.params?._hostStrings);
      applyChartsFollowTextSize(data.params?._chartsFollowTextSize);
      applyScrollWide(data.params?._scrollWide);
      applyKeepMenuClear(data.params?._keepMenuClear);
      applyHoldFrameSized(data.params?._holdFrameSized);
      try {
        applyHostTextSizeToCharts2();
      } catch {
      }
      readHostDisplay(data.params);
    }
  });
  window.initHostContext = initHostContext2;
  window.applyHostTextSizeToCharts = applyHostTextSizeToCharts2;

  // src/scripts/standalone-page.ts
  function standalonePage(code) {
    const page = document.implementation.createHTMLDocument();
    page.documentElement.setAttribute("data-saved", "");
    page.documentElement.toggleAttribute(
      "data-center-content",
      document.documentElement.hasAttribute("data-center-content")
    );
    page.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    for (const link of document.head.querySelectorAll('link[rel="stylesheet"]')) {
      const saved = page.importNode(link, true);
      const cdnHref = saved.getAttribute("data-cdn-href");
      if (cdnHref !== null) {
        saved.setAttribute("href", cdnHref);
      }
      for (const name of ["data-cdn-href", "data-failed", "onerror"]) {
        saved.removeAttribute(name);
      }
      page.head.append(saved);
      if (saved.hasAttribute("onload")) {
        saved.setAttribute("media", "print");
        const plain = page.importNode(saved, true);
        plain.removeAttribute("onload");
        plain.removeAttribute("media");
        const noscript = page.createElement("noscript");
        noscript.append(plain);
        page.head.append(noscript);
      }
    }
    const sheets = headSheets().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*\n/g, "\n").replace(/<\/(style)/gi, "<\\/$1");
    const ownRules = `body { padding: ${MARGIN}px; background: ${PAGE_COLOUR}; }
#vis-container { overflow: visible; }`;
    for (const css of [sheets, ownRules]) {
      const style = page.createElement("style");
      style.textContent = css;
      page.head.append(style);
    }
    const markers = document.getElementById("arrow")?.closest("svg");
    if (markers) {
      page.body.append(page.importNode(markers, true));
    }
    const container3 = page.createElement("div");
    container3.id = "vis-container";
    container3.innerHTML = code;
    page.body.append(container3);
    return `<!doctype html>
${page.documentElement.outerHTML}
`;
  }

  // src/scripts/elicit-log.ts
  var ELICIT_KNOWN_SOURCES = [
    "proud-planet-slides",
    "proud-planet-design",
    "proud-planet-slides-blank",
    "proud-planet-design-blank",
    "lucky-gadget"
  ];
  var ELICIT_SOURCES = [
    ...ELICIT_KNOWN_SOURCES,
    "none",
    "other"
  ];
  function elicitLoggerName(event, source) {
    return `viz:elicit:${event}:${source}`;
  }

  // src/scripts/elicitation.ts
  var shownForms = /* @__PURE__ */ new Set();
  function elicitSource(form) {
    const written = form?.getAttribute("data-source");
    if (!written) {
      return "none";
    }
    return ELICIT_KNOWN_SOURCES.find((known) => known === written) ?? "other";
  }
  function reportElicit(event, form) {
    try {
      const source = elicitSource(form);
      app.sendNotification({
        method: "notifications/message",
        params: {
          level: "info",
          logger: elicitLoggerName(event, source),
          data: { event, source }
        }
      });
    } catch {
    }
  }
  var selectedFiles = /* @__PURE__ */ new Map();
  var submittedKey;
  var FADE_MS = 150;
  function cssStringEscape(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function fingerprint(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) + h + s.charCodeAt(i) | 0;
    }
    return `elicit-submitted:${s.length}:${h.toString(36)}`;
  }
  function escapeHtml(s) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return s.replace(/[&<>"']/g, (c) => map[c]);
  }
  function renderFileTile(container3, name, file) {
    const tile = document.createElement("div");
    tile.className = "elicit-file-tile";
    const dot = file.name.lastIndexOf(".");
    const ext = dot > 0 && file.name.length - dot <= 6 ? file.name.slice(dot + 1).toUpperCase() : "FILE";
    tile.innerHTML = `
    <button type="button" class="remove" aria-label="Remove ${escapeHtml(file.name)}">\xD7</button>
    <div class="name">${escapeHtml(file.name)}</div>
    <div class="badge">${escapeHtml(ext)}</div>
  `;
    tile.querySelector(".remove")?.addEventListener("click", () => {
      const list = selectedFiles.get(name);
      if (list) {
        const idx = list.indexOf(file);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      }
      tile.remove();
    });
    container3.appendChild(tile);
  }
  function renderSubmittedSummary(form, answers, skipped) {
    const summary = document.createElement("div");
    summary.className = "elicit-summary";
    const appendRow = (label, parts) => {
      const row = document.createElement("div");
      row.className = "elicit-summary-row";
      if (label !== void 0) {
        const q = document.createElement("span");
        q.className = "elicit-summary-q";
        q.textContent = label;
        row.appendChild(q);
      }
      for (const part of parts) {
        const a = document.createElement("span");
        a.className = "elicit-summary-a";
        a.textContent = part;
        row.appendChild(a);
      }
      summary.appendChild(row);
    };
    const nonEmpty = (v) => {
      if (v === void 0 || v === "") {
        return void 0;
      }
      if (Array.isArray(v)) {
        return v.length ? v.join(", ") : void 0;
      }
      return v;
    };
    if (skipped) {
      appendRow(void 0, ["Skipped \u2014 proceeding with defaults."]);
    } else {
      const seen = /* @__PURE__ */ new Set();
      form.querySelectorAll(".elicit-group").forEach((group2) => {
        const label = group2.querySelector(".elicit-question")?.textContent?.trim();
        const parts = [];
        group2.querySelectorAll("[data-name]").forEach((el) => {
          const name = el.dataset.name;
          if (!name || seen.has(name)) {
            return;
          }
          seen.add(name);
          const v = nonEmpty(answers[name]);
          if (v !== void 0) {
            parts.push(v);
          }
          const other = nonEmpty(answers[`${name}_other`]);
          if (other !== void 0) {
            seen.add(`${name}_other`);
            parts.push(other);
          }
        });
        if (parts.length) {
          appendRow(label, parts);
        }
      });
      for (const [name, value] of Object.entries(answers)) {
        if (seen.has(name)) {
          continue;
        }
        const v = nonEmpty(value);
        if (v !== void 0) {
          appendRow(name, [v]);
        }
      }
      if (summary.childElementCount === 0) {
        appendRow(void 0, ["Submitted with defaults."]);
      }
    }
    form.querySelector(".elicit-body")?.replaceChildren(summary);
  }
  function wireElicitation() {
    const form = document.querySelector("form.elicit");
    if (!form) {
      return;
    }
    selectedFiles.clear();
    let submitted = false;
    form.addEventListener("submit", (e) => e.preventDefault());
    submittedKey = fingerprint(form.innerHTML);
    try {
      const stored = sessionStorage.getItem(submittedKey);
      if (stored) {
        form.classList.add("elicit-submitted", "elicit-restored");
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object" && "answers" in parsed && "skipped" in parsed) {
          renderSubmittedSummary(
            form,
            parsed.answers,
            parsed.skipped
          );
        }
        return;
      }
    } catch {
    }
    if (!shownForms.has(submittedKey)) {
      shownForms.add(submittedKey);
      reportElicit("shown", form);
    }
    form.querySelectorAll(".elicit-pills").forEach((container3) => {
      const isMulti = container3.dataset.multi === "true";
      const name = container3.dataset.name;
      container3.querySelectorAll(".elicit-pill").forEach((p) => p.setAttribute("aria-pressed", "false"));
      container3.addEventListener("click", (e) => {
        const pill = e.target.closest(
          ".elicit-pill"
        );
        if (!pill) {
          return;
        }
        if (!isMulti) {
          container3.querySelectorAll(".elicit-pill[aria-pressed]").forEach((p) => {
            if (p !== pill) {
              p.setAttribute("aria-pressed", "false");
            }
          });
        }
        const nowSelected = pill.getAttribute("aria-pressed") !== "true";
        pill.setAttribute("aria-pressed", String(nowSelected));
        if (name) {
          const otherInput = form.querySelector(
            `.elicit-other[data-for="${cssStringEscape(name)}"]`
          );
          if (otherInput) {
            const otherPillSelected = container3.querySelector(
              '.elicit-pill[data-other][aria-pressed="true"]'
            ) !== null;
            otherInput.hidden = !otherPillSelected;
            if (otherPillSelected) {
              otherInput.focus();
            }
          }
        }
      });
    });
    form.querySelectorAll(".elicit-files[data-name]").forEach((container3) => {
      const name = container3.dataset.name;
      selectedFiles.set(name, []);
      const dropzone = container3.querySelector(".elicit-dropzone");
      const input = dropzone?.querySelector("input[type='file']");
      if (!dropzone || !input) {
        return;
      }
      if (dropzone.tagName !== "LABEL") {
        dropzone.addEventListener("click", (e) => {
          if (e.target === input) {
            return;
          }
          input.click();
        });
      }
      input.addEventListener("change", () => {
        const files = Array.from(input.files ?? []);
        for (const file of files) {
          const entry = {
            name: file.name,
            size: file.size,
            type: file.type,
            raw: file
          };
          selectedFiles.get(name).push(entry);
          renderFileTile(container3, name, entry);
        }
        input.value = "";
      });
    });
    form.querySelector(".elicit-submit")?.addEventListener("click", () => {
      if (submitted) {
        return;
      }
      submitted = true;
      window.submitElicitation(collectElicitAnswers());
    });
    form.querySelector(".elicit-skip")?.addEventListener("click", () => {
      if (submitted) {
        return;
      }
      submitted = true;
      window.submitElicitation({}, { skipped: true });
    });
  }
  function collectElicitAnswers() {
    const form = document.querySelector("form.elicit");
    if (!form) {
      return {};
    }
    const answers = {};
    form.querySelectorAll(".elicit-pills[data-name]").forEach((container3) => {
      const name = container3.dataset.name;
      const isMulti = container3.dataset.multi === "true";
      const selected = Array.from(
        container3.querySelectorAll(
          ".elicit-pill[aria-pressed='true']"
        )
      ).map((p) => p.dataset.value ?? p.textContent?.trim() ?? "");
      answers[name] = isMulti ? selected : selected[0] ?? "";
      const otherInput = form.querySelector(
        `.elicit-other[data-for="${cssStringEscape(name)}"]`
      );
      if (otherInput && !otherInput.hidden && otherInput.value.trim()) {
        answers[`${name}_other`] = otherInput.value.trim();
      }
    });
    for (const [name, files] of selectedFiles) {
      if (files.length === 0) {
        continue;
      }
      answers[name] = files.map((f) => `${f.name} (attached)`);
    }
    form.querySelectorAll(
      "[data-name]:not(.elicit-pills):not(.elicit-other):not(.elicit-files)"
    ).forEach((el) => {
      const name = el.dataset.name;
      if (name && el.value.trim()) {
        answers[name] = el.value.trim();
      }
    });
    return answers;
  }
  window.submitElicitation = function submitElicitation(answers, options = {}) {
    const skipped = options.skipped ?? false;
    const form = document.querySelector("form.elicit");
    const title = form?.querySelector(".elicit-header > span")?.textContent?.trim();
    if (form) {
      form.classList.add("elicit-transitioning");
      const swap = () => {
        if (!form.isConnected) {
          return;
        }
        form.classList.add("elicit-submitted");
        renderSubmittedSummary(form, answers, skipped);
        form.classList.remove("elicit-transitioning");
      };
      setTimeout(swap, FADE_MS);
    }
    const persistSubmitted = () => {
      if (!submittedKey) {
        return;
      }
      try {
        sessionStorage.setItem(
          submittedKey,
          JSON.stringify({ answers, skipped })
        );
      } catch {
        try {
          sessionStorage.setItem(submittedKey, "1");
        } catch {
        }
      }
    };
    if (skipped) {
      window.sendPrompt(
        "(Skipped the form \u2014 proceed with defaults or ask me in plain text)"
      );
      persistSubmitted();
      reportElicit("skipped", form);
      return;
    }
    const rawFiles = [];
    for (const list of selectedFiles.values()) {
      for (const f of list) {
        rawFiles.push(f.raw);
      }
    }
    const humanizeKey = (k) => {
      let suffix = "";
      if (k.endsWith("_other")) {
        k = k.slice(0, -"_other".length);
        suffix = " (other)";
      } else if (k.endsWith("_file")) {
        k = k.slice(0, -"_file".length);
        suffix = " file";
      } else if (k.endsWith("_text")) {
        k = k.slice(0, -"_text".length);
      }
      const words = k.replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1) + suffix;
    };
    const FOLD_AT = 200;
    const prefix = title ? `${title} \u2014 ` : "";
    const pairs = [];
    const folds = [];
    for (const [k, v] of Object.entries(answers)) {
      if (v === "" || Array.isArray(v) && v.length === 0) {
        continue;
      }
      const raw = Array.isArray(v) ? v.join(", ") : v;
      const label = humanizeKey(k);
      if (raw.length > FOLD_AT) {
        pairs.push(`${label}: (${raw.length} chars \u2014 see below)`);
        folds.push(`[${label}]
${raw}`);
      } else {
        const flat = raw.replace(/\r?\n/g, " / ");
        const value = flat.length > 80 ? `"${flat}"` : flat;
        pairs.push(`${label}: ${value}`);
      }
    }
    let payload = pairs.length === 0 ? `${prefix}proceeding with defaults.` : `${prefix}${pairs.join(" \xB7 ")}`;
    if (folds.length > 0) {
      payload += `

--- Full content ---
${folds.join("\n\n")}`;
    }
    if (rawFiles.length > 0) {
      proxyPage.postMessage(
        { type: "anthropic:elicit-submit", text: payload, files: rawFiles },
        "*"
      );
    } else {
      window.sendPrompt(payload);
      persistSubmitted();
    }
    reportElicit(pairs.length === 0 ? "submitted_empty" : "submitted", form);
  };
  window.collectElicitAnswers = collectElicitAnswers;
  window._wireElicitation = wireElicitation;

  // src/scripts/after-the-visual.ts
  function afterTheVisual(type, concerns, decide) {
    window.addEventListener(
      type,
      (event) => {
        if (!concerns(event)) {
          return;
        }
        const stops = event.composedPath();
        const last2 = event.bubbles ? stops[stops.length - 1] : stops[0];
        const tidy = new AbortController();
        const settle = () => {
          if (event.eventPhase && !tidy.signal.aborted) {
            tidy.abort();
            decide(event);
          }
        };
        const follow = (stop) => stop.addEventListener(
          type,
          (seen) => {
            if (seen !== event) {
              return;
            }
            if (event.cancelBubble || stop === last2) {
              settle();
            } else {
              follow(stops[stops.indexOf(stop) + 1]);
            }
          },
          { signal: tidy.signal }
        );
        follow(stops[0]);
        const end = event.stopImmediatePropagation;
        Reflect.defineProperty(event, "stopImmediatePropagation", {
          configurable: true,
          writable: true,
          value: () => {
            end.call(event);
            if (type === "click" && event.isTrusted) {
              queueMicrotask(settle);
            } else {
              settle();
            }
          }
        });
        setTimeout(() => tidy.abort());
      },
      true
    );
  }

  // src/scripts/drawn-frame.ts
  function namesADrawnFrame(target) {
    return !!target && Array.from(document.getElementsByName(target)).some(
      (node) => node instanceof HTMLIFrameElement
    );
  }
  var orTheBaseTarget = (target) => target || document.querySelector("base[target]")?.getAttribute("target");
  function runsAScript(address) {
    try {
      return new URL(address ?? "", window.location.href).protocol === "javascript:";
    } catch {
      return false;
    }
  }

  // src/scripts/open-link.ts
  var host2 = app;
  function openLink(url) {
    return host2.sendRequest({
      method: "ui/open-link",
      params: { url }
    });
  }
  window.openLink = openLink;
  function forTheHost(href) {
    try {
      const url = new URL(href, window.location.href).href;
      return href && /^(https?|mailto|tel|sms):/.test(url) ? url : void 0;
    } catch {
      return void 0;
    }
  }
  var browserOpen = window.open;
  window.open = (url, target, features) => {
    if (namesADrawnFrame(target)) {
      return browserOpen.call(window, url, target, features);
    }
    const address = forTheHost(String(url ?? "").trim());
    if (address && navigator.userActivation?.isActive !== false) {
      openLink(address);
    }
    return null;
  };
  var elementsIn = (event) => event.composedPath().filter((node) => node instanceof Element);
  var hrefOf = (node) => node.getAttribute("href") ?? node.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  function usesTheClick(node) {
    if (node instanceof HTMLLabelElement) {
      return node.control !== null;
    }
    if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
      return /^(checkbox|radio|file|color|date|time|month|week|datetime-local)$/.test(
        node.type
      ) || node.form !== null && /^(submit|reset|image)$/.test(node.type);
    }
    return node.matches("summary, video[controls], audio[controls]");
  }
  function followLink(event) {
    const path = elementsIn(event);
    const link = path.find(
      (node) => node.matches("a, area") && hrefOf(node) !== null
    );
    const href = link && hrefOf(link)?.trim();
    if (!link || href === void 0 || event.defaultPrevented || runsAScript(href)) {
      return;
    }
    if (link.hasAttribute("download") && /^(blob|data):/i.test(href)) {
      return;
    }
    const jump = href.startsWith("#");
    const url = jump ? void 0 : forTheHost(href);
    if (!url?.startsWith("http") && (path.slice(0, path.indexOf(link)).some(usesTheClick) || link instanceof HTMLElement && link.isContentEditable || namesADrawnFrame(orTheBaseTarget(link.getAttribute("target"))))) {
      return;
    }
    if (jump && document.baseURI.split("#")[0] === window.location.href.split("#")[0]) {
      return;
    }
    event.preventDefault();
    const aim = jump ? document.getElementById(href.slice(1)) : null;
    if (url) {
      openLink(url);
    } else if (link instanceof SVGElement && aim && "beginElement" in aim && typeof aim.beginElement === "function") {
      aim.beginElement();
    } else if (jump) {
      window.location.replace(new URL(href, window.location.href).href);
    }
  }
  afterTheVisual(
    "click",
    (event) => elementsIn(event).some((node) => node.matches("a, area")),
    followLink
  );
  document.getElementById("vis-container").addEventListener("click", () => void 0);

  // src/scripts/open-larger.ts
  var ZOOM_STEP = 1.25;
  var MOST_ZOOM = 3;
  var LEAST_FIT = 0.5;
  function offersOpenLarger(host3, doc) {
    return host3.platform === "mobile" && host3.availableDisplayModes.includes("fullscreen") && !doc.querySelector("form.elicit");
  }
  var hostApp3 = app;
  var SIDES = ["top", "right", "bottom", "left"];
  var root2 = document.documentElement;
  var scrollArea = document.body;
  var container = document.getElementById("vis-container");
  var openButton = document.getElementById("larger-open");
  var zoomButtons = document.getElementById("larger-zoom");
  var zoomOutButton = document.getElementById("larger-zoom-out");
  var zoomInButton = document.getElementById("larger-zoom-in");
  var zoomStatus = document.getElementById("larger-zoom-status");
  var switchedOn = false;
  var finalRendered = false;
  var asking = 0;
  var requestsSent = 0;
  var ANSWER_WAIT_MS = 5e3;
  var refused = false;
  var laidOutLarger = false;
  var laidOutInsets = "";
  var zoom = 1;
  var fitZoom = 1;
  var zoomedByHand = false;
  var handZoom;
  function cappedDrawingsFilling() {
    const full = container?.getBoundingClientRect().width ?? 0;
    return Array.from(
      container?.querySelectorAll("svg") ?? []
    ).filter((svg) => {
      const { width } = svg.getBoundingClientRect();
      return width > 0 && Math.abs(width - full) < 1 && svg.style.maxWidth.endsWith("px");
    });
  }
  function widthDrawingsLack() {
    let lack = 0;
    for (const svg of cappedDrawingsFilling()) {
      lack = Math.max(
        lack,
        parseFloat(svg.style.maxWidth) - svg.getBoundingClientRect().width
      );
    }
    return lack;
  }
  var roomAbove = 0;
  function makeRoom() {
    const had = root2.hasAttribute("data-zoomed-in");
    const on = laidOutLarger && lead.y === 0 && zoom > fitZoom + 1e-3 && scrollArea.scrollHeight - roomAbove > scrollArea.clientHeight;
    if (on === had) {
      return;
    }
    const px2 = (value) => parseFloat(value) || 0;
    const scrolled = scrollArea.scrollTop;
    const before = px2(getComputedStyle(scrollArea).paddingTop);
    root2.toggleAttribute("data-zoomed-in", on);
    const above = px2(getComputedStyle(scrollArea).paddingTop) - before;
    roomAbove = on ? above : 0;
    scrollArea.scrollTop = scrolled + above;
    if (pinchScroll) {
      pinchScroll.top = Math.max(pinchScroll.top + above, 0);
    }
  }
  var lead = { x: 0, y: 0 };
  var space = { x: 0, y: 0 };
  var widthAtOne = 0;
  var fitAxis = "";
  function centre() {
    const box = container?.getBoundingClientRect();
    const drawn = container && box && box.width > 0 && container.clientWidth > 0 ? {
      x: widthAtOne * zoom * Math.max(container.scrollWidth / container.clientWidth, 1),
      y: box.height / box.width * widthAtOne * zoom
    } : { x: 0, y: 0 };
    const half = (left) => left >= 1 ? left / 2 : 0;
    lead = {
      x: drawn.x > 0 && fitAxis !== "x" ? half(space.x - drawn.x) : 0,
      y: drawn.y > 0 && fitAxis !== "y" ? half(space.y - drawn.y) : 0
    };
    root2.style.setProperty("--larger-lead-x", lead.x + "px");
    root2.style.setProperty("--larger-lead-y", lead.y + "px");
    return drawn;
  }
  var settleFrame = 0;
  var contentSize = () => container ? container.scrollWidth + "x" + container.offsetHeight : "";
  function fitWhileSettling(framesLeft = 10, steady = 0, size = contentSize()) {
    cancelAnimationFrame(settleFrame);
    settleFrame = requestAnimationFrame(() => {
      if (!laidOutLarger || zoomedByHand || gestureZoom !== void 0) {
        return;
      }
      const now = contentSize();
      if (now !== size) {
        layOutLarger(false);
      }
      if (framesLeft > 1 && (now !== size || steady < 2)) {
        fitWhileSettling(framesLeft - 1, now === size ? steady + 1 : 0);
      }
    });
  }
  function layOutLarger(settle = true) {
    if (!container) {
      return;
    }
    const { scrollLeft, scrollTop } = scrollArea;
    container.style.width = "";
    container.style.zoom = "";
    container.style.marginRight = "";
    root2.style.removeProperty("--larger-lead-x");
    root2.style.removeProperty("--larger-lead-y");
    lead = { x: 0, y: 0 };
    pinch = void 0;
    const padding = getComputedStyle(scrollArea);
    const px2 = (value) => parseFloat(value) || 0;
    const besidePill = scrollArea.clientWidth - px2(padding.paddingRight);
    const pill = zoomButtons?.getBoundingClientRect();
    const right = Math.min(
      Math.max(pill?.right ?? 0, besidePill),
      scrollArea.clientWidth
    );
    const availableWidth = right - px2(padding.paddingLeft);
    const width = Math.max(availableWidth, 0);
    container.style.width = width + "px";
    container.style.width = width + widthDrawingsLack() + "px";
    if (cappedDrawingsFilling().length === 0) {
      container.style.width = width + "px";
    }
    const wholeWidthFit = availableWidth / Math.max(container.offsetWidth, container.scrollWidth);
    widthAtOne = container.getBoundingClientRect().width;
    const stickOut = container.scrollWidth - container.clientWidth;
    container.style.marginRight = stickOut > 0 ? stickOut + "px" : "";
    const widthFit = wholeWidthFit < LEAST_FIT ? availableWidth / container.offsetWidth : wholeWidthFit;
    const availableHeight = scrollArea.clientHeight - (px2(padding.paddingTop) - roomAbove) - px2(padding.paddingBottom);
    const heightFit = availableHeight / container.offsetHeight;
    const fit2 = heightFit < LEAST_FIT ? widthFit : Math.min(widthFit, heightFit);
    fitZoom = Number.isFinite(fit2) && fit2 > 0 ? Math.min(fit2, MOST_ZOOM) : 1;
    space = { x: availableWidth, y: availableHeight };
    const drawnHeight = (at) => {
      container.style.zoom = String(at);
      const box = container.getBoundingClientRect();
      return box.width > 0 ? box.height / box.width * widthAtOne * at : 0;
    };
    const lowest = Math.max(LEAST_FIT, fitZoom * 0.95);
    let drawn = drawnHeight(fitZoom);
    for (let i = 0; i < 3 && drawn > availableHeight + 0.5; i++) {
      const narrowed = fitZoom * availableHeight / drawn;
      if (narrowed < lowest) {
        break;
      }
      const now = drawnHeight(narrowed);
      if (now >= drawn) {
        break;
      }
      fitZoom = narrowed;
      drawn = now;
    }
    fitAxis = fit2 > MOST_ZOOM ? "" : fit2 === widthFit && fitZoom === fit2 ? "x" : "y";
    zoom = handZoom === void 0 ? fitZoom : clampZoom(handZoom, fitZoom);
    zoomedByHand = zoom > fitZoom + 1e-3;
    container.style.zoom = String(zoom);
    centre();
    scrollArea.scrollLeft = scrollLeft;
    scrollArea.scrollTop = scrollTop;
    markZoomEnds();
    makeRoom();
    sharpenSoon();
    if (settle) {
      fitWhileSettling();
    }
  }
  var MOST_CHART_PIXELS = 4096 * 4096;
  var shapedByBitmap = /* @__PURE__ */ new WeakSet();
  function sharpenCharts(most = zoom) {
    const chartJs = window.Chart;
    const retinaScale = chartJs?.helpers?.retinaScale;
    if (!retinaScale) {
      return;
    }
    const charts = Object.values(chartJs?.instances ?? {}).flatMap((chart) => {
      try {
        const ratio = chart.options.devicePixelRatio;
        const pixels2 = chart.width * chart.height * ratio ** 2;
        const { width, height } = chart.canvas.style;
        return pixels2 > 0 && // retinaScale writes an inline size on a canvas that has none, which would override the size a stylesheet gives it.
        (width || height) && // Drawing would apply a resize that Chart.js put off while the chart was animating, and so change the chart's size.
        !chart._resizeBeforeDraw && !shapedByBitmap.has(chart.canvas) ? [{ chart, ratio, pixels: pixels2 }] : [];
      } catch {
        return [];
      }
    });
    const pixels = charts.reduce((sum, chart) => sum + chart.pixels, 0);
    const finer = Math.max(
      Math.min(most, Math.sqrt(MOST_CHART_PIXELS / pixels)),
      1
    );
    for (const { chart, ratio } of charts) {
      try {
        if (chart.currentDevicePixelRatio === ratio * finer) {
          continue;
        }
        const cssSize = () => {
          const { width, height } = getComputedStyle(chart.canvas);
          return width + height;
        };
        const before = cssSize();
        retinaScale(chart, ratio * finer);
        if (cssSize() !== before) {
          shapedByBitmap.add(chart.canvas);
          retinaScale(chart, ratio);
        }
        chart.render();
        if (chartJs?.animator?.has(chart)) {
          chart.draw();
        }
      } catch {
      }
    }
    bitmapSizes.takeRecords();
  }
  var SHARPEN_WAIT_MS = 250;
  var sharpening;
  function sharpenSoon() {
    clearTimeout(sharpening);
    sharpening = setTimeout(() => sharpenCharts(), SHARPEN_WAIT_MS);
  }
  var bitmapSizes = new MutationObserver(sharpenSoon);
  var tapPlaces = {
    id: "largerViewTaps",
    beforeEvent(chart, args) {
      try {
        const { native } = args.event;
        const point = "touches" in native ? native.touches[0] : native;
        if (args.replay || !native.isTrusted || !point || !laidOutLarger || !container?.contains(chart.canvas)) {
          return;
        }
        const { clientX, clientY } = point;
        const box = chart.canvas.getBoundingClientRect();
        const uncounted = zoom * container.offsetWidth / container.getBoundingClientRect().width;
        const scale = box.width * uncounted / chart.canvas.offsetWidth;
        const place = window.Chart?.helpers?.getRelativePosition?.(
          {
            clientX: box.left + (clientX - box.left * uncounted) / scale,
            clientY: box.top + (clientY - box.top * uncounted) / scale
          },
          chart
        );
        if (place) {
          args.inChartArea = chart.isPointInArea(place);
          Object.assign(args.event, place);
        }
      } catch {
      }
    }
  };
  function correctTaps() {
    try {
      const chartJs = window.Chart;
      chartJs?.[laidOutLarger ? "register" : "unregister"]?.(tapPlaces);
    } catch {
    }
  }
  function clampZoom(value, least) {
    return Math.min(Math.max(value, least), MOST_ZOOM);
  }
  function markZoomEnds() {
    zoomOutButton?.setAttribute("aria-disabled", String(zoom <= fitZoom + 1e-3));
    zoomInButton?.setAttribute("aria-disabled", String(zoom >= MOST_ZOOM - 1e-3));
  }
  function scrollKeeping(scroll, size, before, ratio, point, start = 0, after = before) {
    if (point === void 0 && scroll <= start + 1) {
      return scroll;
    }
    const p = point ?? size / 2;
    return (scroll + p - before) * ratio + after - p;
  }
  function zoomTo(next, at) {
    const target = clampZoom(next, fitZoom);
    if (!laidOutLarger || !Number.isFinite(target) || Math.abs(target - zoom) < 1e-3) {
      return;
    }
    const ratio = target / zoom;
    zoom = target;
    zoomedByHand = zoom > fitZoom + 1e-3;
    handZoom = zoomedByHand ? zoom : void 0;
    const { clientWidth, clientHeight } = scrollArea;
    const from = at && pinchScroll ? pinchScroll : { left: scrollArea.scrollLeft, top: scrollArea.scrollTop };
    const style = getComputedStyle(scrollArea);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const had = lead;
    if (container) {
      container.style.zoom = String(zoom);
    }
    const drawn = centre();
    const keepMiddle = (scroll, leadNow, size, span) => scroll + leadNow + size / 2 - span / 2;
    const left = !at && had.x > 0 ? keepMiddle(from.left, lead.x, drawn.x, space.x) : scrollKeeping(
      from.left,
      clientWidth,
      padLeft,
      ratio,
      at?.x,
      0,
      padLeft - had.x + lead.x
    );
    const top = !at && had.y > 0 ? keepMiddle(from.top, lead.y, drawn.y, space.y) : scrollKeeping(
      from.top,
      clientHeight,
      padTop,
      ratio,
      at?.y,
      roomAbove,
      padTop - had.y + lead.y
    );
    scrollArea.scrollLeft = left;
    scrollArea.scrollTop = top;
    if (at && pinchScroll) {
      pinchScroll = {
        left: Math.max(
          Math.min(left, scrollArea.scrollWidth - scrollArea.clientWidth),
          0
        ),
        top: Math.max(
          Math.min(top, scrollArea.scrollHeight - scrollArea.clientHeight),
          0
        )
      };
    }
    markZoomEnds();
    makeRoom();
    sharpenSoon();
  }
  function announceZoom() {
    if (zoomStatus) {
      const hostStr = (key) => {
        const strings = window.__hostStrings;
        const value = strings?.[key];
        return typeof value === "string" && value.trim() ? value : void 0;
      };
      const percent = String(Math.round(zoom / fitZoom * 100));
      const template = hostStr("zoomStatus") ?? "Zoom {percent}%";
      zoomStatus.textContent = (template.includes("{percent}") ? template : "Zoom {percent}%").replace("{percent}", percent);
    }
  }
  function leaveLarger() {
    cancelAnimationFrame(settleFrame);
    root2.removeAttribute("data-zoomed-in");
    roomAbove = 0;
    zoom = 1;
    zoomedByHand = false;
    handZoom = void 0;
    pinch = void 0;
    gestureZoom = void 0;
    touches.clear();
    if (container) {
      container.style.width = "";
      container.style.zoom = "";
      container.style.marginRight = "";
    }
    root2.style.removeProperty("--larger-lead-x");
    root2.style.removeProperty("--larger-lead-y");
    lead = { x: 0, y: 0 };
    if (zoomStatus) {
      zoomStatus.textContent = "";
    }
    sharpenSoon();
  }
  function update() {
    const host3 = hostDisplay();
    const focused = document.hasFocus() ? document.activeElement : null;
    for (const side of SIDES) {
      if (switchedOn) {
        root2.style.setProperty(
          "--host-inset-" + side,
          host3.safeAreaInsets[side] + "px"
        );
      } else {
        root2.style.removeProperty("--host-inset-" + side);
      }
    }
    const offered = switchedOn && finalRendered && offersOpenLarger(host3, document);
    const fullscreen = host3.displayMode === "fullscreen";
    if (fullscreen) {
      refused = false;
      asking = 0;
    }
    const larger = offered && fullscreen;
    const entering = larger && !laidOutLarger;
    const leaving = !larger && laidOutLarger;
    const insets = SIDES.map((side) => host3.safeAreaInsets[side]).join(" ");
    laidOutLarger = larger;
    root2.toggleAttribute("data-open-larger", larger);
    openButton?.toggleAttribute("hidden", !offered || fullscreen || refused);
    if (openButton?.hidden) {
      openButton.setAttribute("data-resting", "");
    }
    zoomButtons?.toggleAttribute("hidden", !larger);
    if (entering) {
      document.addEventListener("touchmove", keepPinch, { passive: false });
      if (container) {
        bitmapSizes.observe(container, {
          subtree: true,
          attributeFilter: ["width"]
        });
      }
      scrollArea.scrollLeft = 0;
      scrollArea.scrollTop = 0;
      layOutLarger();
      correctTaps();
      if (focused && focused === openButton) {
        zoomInButton?.focus({ preventScroll: true });
      }
    } else if (leaving) {
      document.removeEventListener("touchmove", keepPinch);
      bitmapSizes.disconnect();
      leaveLarger();
      correctTaps();
      if (focused && zoomButtons?.contains(focused)) {
        openButton?.focus({ preventScroll: true });
      }
    } else if (larger && insets !== laidOutInsets) {
      layOutLarger();
    }
    laidOutInsets = insets;
  }
  async function askForFullScreen() {
    if (asking || !switchedOn || !finalRendered || !offersOpenLarger(hostDisplay(), document)) {
      return;
    }
    const request = ++requestsSent;
    asking = request;
    const stopWaiting = () => {
      if (asking === request) {
        asking = 0;
      }
    };
    const gaveUp2 = setTimeout(stopWaiting, ANSWER_WAIT_MS);
    const changesWhenAsked = displayModeChangeCount();
    try {
      const answer = await hostApp3.requestDisplayMode({ mode: "fullscreen" });
      if (displayModeChangeCount() !== changesWhenAsked) {
        return;
      }
      if (answer?.mode === "fullscreen") {
        takeDisplayMode("fullscreen");
      } else if (answer?.mode === "inline") {
        refused = true;
        update();
      }
    } catch {
    } finally {
      clearTimeout(gaveUp2);
      stopWaiting();
    }
  }
  openButton?.addEventListener("click", () => void askForFullScreen());
  var TAP_SLOP_PX = 10;
  var TAP_MAX_MS = 500;
  var ARMING_MS = 400;
  var armed;
  var tapStart;
  var listen = { capture: true, passive: true };
  document.addEventListener(
    "pointerdown",
    (event) => {
      const second = tapStart !== void 0 && event.timeStamp - tapStart.at <= TAP_MAX_MS;
      tapStart = second ? void 0 : {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp
      };
    },
    listen
  );
  document.addEventListener(
    "pointercancel",
    () => tapStart = void 0,
    listen
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      const start = tapStart;
      tapStart = void 0;
      if (!openButton || openButton.hidden || start?.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX || event.timeStamp - start.at > TAP_MAX_MS || event.target instanceof Node && openButton.contains(event.target)) {
        return;
      }
      if (!openButton.toggleAttribute("data-resting")) {
        openButton.setAttribute("data-arming", "");
        clearTimeout(armed);
        armed = setTimeout(
          () => openButton.removeAttribute("data-arming"),
          ARMING_MS
        );
      }
    },
    listen
  );
  zoomOutButton?.addEventListener("click", () => {
    pinch = void 0;
    zoomTo(zoom / ZOOM_STEP);
    announceZoom();
  });
  zoomInButton?.addEventListener("click", () => {
    pinch = void 0;
    zoomTo(zoom * ZOOM_STEP);
    announceZoom();
  });
  var touches = /* @__PURE__ */ new Map();
  var pinch;
  var gestureZoom;
  var pinchScroll;
  var spread = () => {
    const [a, b] = [...touches.values()];
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2
    };
  };
  var track = (event) => {
    if (!laidOutLarger || event.pointerType !== "touch") {
      return;
    }
    if (event.type === "pointerdown") {
      if (event.isPrimary) {
        touches.clear();
        gestureZoom = void 0;
      }
      pinch = void 0;
    }
    if (event.type === "pointerdown" || touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (touches.size !== 2) {
      return;
    }
    const now = spread();
    gestureZoom ?? (gestureZoom = zoom);
    if (!pinch) {
      pinch = { distance: now.distance, zoom };
      pinchScroll = { left: scrollArea.scrollLeft, top: scrollArea.scrollTop };
    } else if (pinch.distance > 0) {
      const frame = scrollArea.getBoundingClientRect();
      zoomTo(pinch.zoom * now.distance / pinch.distance, {
        x: now.x - frame.left,
        y: now.y - frame.top
      });
    }
  };
  var untrack = (event) => {
    if (touches.delete(event.pointerId)) {
      pinch = void 0;
    }
    if (touches.size === 0 && gestureZoom !== void 0) {
      const changed = Math.abs(zoom - gestureZoom) > 1e-3;
      gestureZoom = void 0;
      if (changed) {
        announceZoom();
      }
    }
  };
  document.addEventListener("pointerdown", track, listen);
  document.addEventListener("pointermove", track, listen);
  document.addEventListener("pointerup", untrack, listen);
  document.addEventListener("pointercancel", untrack, listen);
  var keepPinch = (event) => {
    if (event.touches.length >= 2 && event.cancelable) {
      event.preventDefault();
    }
  };
  window.addEventListener("viz:complete", () => {
    finalRendered = true;
    update();
  });
  window.addEventListener("resize", () => {
    if (laidOutLarger) {
      layOutLarger();
      sharpenCharts(1);
    }
  });
  onHostDisplayChange((context) => {
    if ("_openLarger" in context) {
      switchedOn = context._openLarger === true;
    }
    update();
  });

  // src/scripts/form-submit.ts
  function sparesTheVisual(form, submitter) {
    const own = (name) => submitter?.getAttribute(`form${name}`) ?? form.getAttribute(name);
    return own("method")?.toLowerCase() === "dialog" || runsAScript(own("action")) || namesADrawnFrame(orTheBaseTarget(own("target")));
  }
  afterTheVisual(
    "submit",
    // Only the browser's own submit event loads anything. One that the visual made up is the visual's business.
    (event) => event.isTrusted,
    (event) => {
      if (event.target instanceof Element && !sparesTheVisual(event.target, event.submitter)) {
        event.preventDefault();
      }
    }
  );
  var submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    if (sparesTheVisual(this)) {
      submit.call(this);
    }
  };

  // src/scripts/svg-text-occlusion.ts
  function fixSvgTextOcclusion2(container3) {
    try {
      const svg = container3.querySelector("svg");
      if (!svg) {
        return;
      }
      const NS = "http://www.w3.org/2000/svg";
      const PAD_X = 4;
      const PAD_Y = 2;
      const MIN_CONNECTOR_LEN = 15;
      const textRects = [];
      svg.querySelectorAll("text").forEach((t) => {
        if (t.closest("defs, mask, clipPath, marker")) {
          return;
        }
        try {
          const bb = t.getBBox();
          if (bb.width < 1 || bb.height < 1) {
            return;
          }
          textRects.push({
            x: bb.x - PAD_X,
            y: bb.y - PAD_Y,
            w: bb.width + 2 * PAD_X,
            h: bb.height + 2 * PAD_Y
          });
        } catch {
        }
      });
      if (!textRects.length) {
        return;
      }
      const candidates = [];
      svg.querySelectorAll("line, path, polyline").forEach((el) => {
        if (el.closest("defs, mask, clipPath, marker")) {
          return;
        }
        if (el.tagName.toLowerCase() === "path") {
          const fill = el.getAttribute("fill") || getComputedStyle(el).fill;
          if (fill && fill !== "none" && fill !== "transparent" && !/^rgba\([^)]*,\s*0\)$/.test(fill)) {
            return;
          }
        }
        const geom = el;
        try {
          const len = geom.getTotalLength();
          if (len < MIN_CONNECTOR_LEN) {
            return;
          }
          candidates.push({ el: geom, len });
        } catch {
        }
      });
      if (!candidates.length) {
        return;
      }
      const inRect = (px2, py, r) => px2 >= r.x && px2 <= r.x + r.w && py >= r.y && py <= r.y + r.h;
      const intersecting = [];
      for (const { el, len } of candidates) {
        const step = Math.max(2, len / 80);
        let hit = false;
        for (let d = 0; d <= len && !hit; d += step) {
          const pt = el.getPointAtLength(d);
          for (const r of textRects) {
            if (inRect(pt.x, pt.y, r)) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          intersecting.push(el);
        }
      }
      if (!intersecting.length) {
        return;
      }
      let defs = svg.querySelector(":scope > defs");
      if (!defs) {
        defs = document.createElementNS(NS, "defs");
        svg.insertBefore(defs, svg.firstChild);
      }
      const maskId = `imagine-text-gaps-${Math.random().toString(36).slice(2, 8)}`;
      const mask = document.createElementNS(NS, "mask");
      mask.setAttribute("id", maskId);
      mask.setAttribute("maskUnits", "userSpaceOnUse");
      const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      const [vx, vy, vw, vh] = vb.length === 4 && vb.every((n) => Number.isFinite(n)) ? vb : (() => {
        const bb = svg.getBBox();
        return [bb.x, bb.y, bb.width, bb.height];
      })();
      const bg = document.createElementNS(NS, "rect");
      bg.setAttribute("x", String(vx));
      bg.setAttribute("y", String(vy));
      bg.setAttribute("width", String(vw));
      bg.setAttribute("height", String(vh));
      bg.setAttribute("fill", "white");
      mask.appendChild(bg);
      for (const r of textRects) {
        const hole = document.createElementNS(NS, "rect");
        hole.setAttribute("x", String(r.x));
        hole.setAttribute("y", String(r.y));
        hole.setAttribute("width", String(r.w));
        hole.setAttribute("height", String(r.h));
        hole.setAttribute("fill", "black");
        hole.setAttribute("rx", "2");
        mask.appendChild(hole);
      }
      defs.appendChild(mask);
      for (const el of intersecting) {
        el.setAttribute("mask", `url(#${maskId})`);
      }
    } catch {
    }
  }
  window.fixSvgTextOcclusion = fixSvgTextOcclusion2;

  // src/scripts/svg-clip-fix.ts
  function fixSvgClipping2(container3) {
    try {
      const svg = container3.querySelector("svg");
      if (!svg) {
        return;
      }
      const vb = svg.getAttribute("viewBox");
      if (!vb) {
        return;
      }
      const [vbX, vbY, vbW, vbH] = vb.split(/[\s,]+/).map(Number);
      if (![vbX, vbY, vbW, vbH].every(Number.isFinite)) {
        return;
      }
      if (vbW < 100 || vbH < 100) {
        return;
      }
      let maxX = -Infinity;
      let maxY = -Infinity;
      svg.querySelectorAll(
        ":scope > :not(defs):not(style):not(title):not(desc):not(metadata)"
      ).forEach((el) => {
        try {
          const bb = el.getBBox();
          if (bb.width < 0.5 && bb.height < 0.5) {
            return;
          }
          maxX = Math.max(maxX, bb.x + bb.width);
          maxY = Math.max(maxY, bb.y + bb.height);
        } catch {
        }
      });
      const PAD = 10;
      const vbRight = vbX + vbW;
      const vbBottom = vbY + vbH;
      let newW = vbW;
      if (maxX !== -Infinity && maxX + PAD > vbRight + 1) {
        newW = maxX + PAD - vbX;
      }
      let newH = vbH;
      if (maxY !== -Infinity && maxY + PAD > vbBottom + 1) {
        newH = maxY + PAD - vbY;
      }
      if (newW !== vbW || newH !== vbH) {
        svg.setAttribute(
          "viewBox",
          `${vbX} ${vbY} ${round(newW)} ${round(newH)}`
        );
        const hAttr = svg.getAttribute("height");
        if (hAttr && newH !== vbH) {
          const px2 = parseFloat(hAttr);
          if (Number.isFinite(px2)) {
            svg.setAttribute("height", String(round(px2 * (newH / vbH))));
          }
        }
      }
      svg.style.maxWidth = `${round(newW)}px`;
      svg.style.display = "block";
      svg.style.marginInline = "auto";
    } catch {
    }
  }
  function round(n) {
    return Math.round(n * 100) / 100;
  }
  globalThis.fixSvgClipping = fixSvgClipping2;

  // src/scripts/svg-text-edge-fix.ts
  function fixSvgTextEdgeClip2(container3) {
    try {
      const svg = container3.querySelector("svg");
      if (!svg) {
        return;
      }
      const vb = svg.getAttribute("viewBox");
      if (!vb) {
        return;
      }
      const [vbX, , vbW] = vb.split(/[\s,]+/).map(Number);
      if (!Number.isFinite(vbX) || !Number.isFinite(vbW)) {
        return;
      }
      const vbRight = vbX + vbW;
      const byKey = /* @__PURE__ */ new Map();
      svg.querySelectorAll("text").forEach((text) => {
        if (text.closest("svg") !== svg) {
          return;
        }
        if (text.closest("g[transform]")) {
          return;
        }
        if (text.hasAttribute("transform")) {
          return;
        }
        if (text.querySelector("tspan[x]")) {
          return;
        }
        const p = text.parentElement;
        if (p && p !== svg) {
          const hasBox = Array.from(
            p.querySelectorAll(
              ":scope > rect, :scope > circle, :scope > ellipse"
            )
          ).some((shape) => {
            try {
              return shape.getBBox().width > 10;
            } catch {
              return true;
            }
          });
          if (hasBox) {
            return;
          }
        }
        const anchor = text.getAttribute("text-anchor") || getComputedStyle(text).textAnchor || "start";
        if (anchor !== "start" && anchor !== "end") {
          return;
        }
        let bb;
        try {
          bb = text.getBBox();
        } catch {
          return;
        }
        if (bb.width < 1) {
          return;
        }
        const xAttr = text.getAttribute("x");
        if (!xAttr || /[\s,]/.test(xAttr)) {
          return;
        }
        const x = parseFloat(xAttr);
        if (!Number.isFinite(x)) {
          return;
        }
        const overflow = anchor === "start" ? bb.x + bb.width - vbRight : vbX - bb.x;
        const key = `${anchor}:${x}`;
        const group2 = byKey.get(key) ?? [];
        group2.push({ text, x, anchor, overflow, width: bb.width });
        byKey.set(key, group2);
      });
      byKey.forEach((group2) => {
        const overflowing = group2.filter((g) => g.overflow > 2);
        if (!overflowing.length) {
          return;
        }
        const worst = overflowing.reduce(
          (a, b) => a.overflow > b.overflow ? a : b
        );
        if (worst.overflow > worst.width * 0.5) {
          return;
        }
        const shift = group2[0].anchor === "start" ? -worst.overflow : worst.overflow;
        group2.forEach(
          ({ text, x }) => text.setAttribute("x", String(round2(x + shift)))
        );
      });
    } catch {
    }
  }
  function round2(n) {
    return Math.round(n * 100) / 100;
  }
  globalThis.fixSvgTextEdgeClip = fixSvgTextEdgeClip2;

  // src/scripts/wide-scroll.ts
  var STICK_OUT_PX = 24;
  var SCROLLS = "scrolls-wide";
  var HOST_ALLOWS = "data-scroll-wide";
  var FADE_PX = 32;
  var PARKED_PX = 64;
  var MOST_BOXES = 2e3;
  var REPLACED = /* @__PURE__ */ new Set([
    "img",
    "svg",
    "canvas",
    "video",
    "audio",
    "iframe",
    "embed",
    "object",
    "input",
    "select",
    "textarea",
    "button"
  ]);
  function layoutOf(box, visual2) {
    if (!(box instanceof HTMLElement)) {
      const rect = box.getBoundingClientRect();
      const frame = visual2.getBoundingClientRect();
      const shift = frame.left + visual2.clientLeft - visual2.scrollLeft;
      return { left: rect.left - shift, right: rect.right - shift };
    }
    let left = 0;
    let at = box;
    while (at && at !== visual2) {
      left += at.offsetLeft;
      const parent = at.offsetParent;
      if (parent instanceof HTMLElement && parent !== visual2) {
        left += parent.clientLeft;
      }
      at = parent instanceof HTMLElement ? parent : null;
    }
    return at === visual2 ? { left, right: left + box.offsetWidth } : void 0;
  }
  function flowReach(visual2) {
    let start = 0;
    let end = visual2.clientWidth;
    let read = 0;
    const walk = (parent) => {
      const margins = /flex|grid/.test(getComputedStyle(parent).display);
      for (const box of parent.children) {
        if (++read > MOST_BOXES) {
          return;
        }
        const style = getComputedStyle(box);
        if (style.display === "none" || style.position === "absolute" || style.position === "fixed") {
          continue;
        }
        const overflowX = style.overflowX || style.overflow?.split(" ")[0] || "visible";
        const wraps = style.display === "inline" && box instanceof HTMLElement && !REPLACED.has(box.localName) && box.getClientRects().length > 1;
        const laid = wraps ? void 0 : layoutOf(box, visual2);
        if (laid && laid.right > laid.left) {
          const margin = (side) => margins ? Math.max(0, parseFloat(side) || 0) : 0;
          start = Math.min(start, laid.left - margin(style.marginLeft));
          end = Math.max(end, laid.right + margin(style.marginRight));
          if (overflowX === "visible" && box instanceof HTMLElement && [...box.children].every(
            (child) => ++read <= MOST_BOXES && !REPLACED.has(child.localName) && getComputedStyle(child).display === "inline"
          ) && box.textContent?.trim()) {
            if (style.direction === "rtl") {
              start = Math.min(start, laid.right - box.scrollWidth);
            } else {
              end = Math.max(end, laid.left + box.scrollWidth);
            }
          }
        }
        const clipsItself = overflowX !== "visible" || style.contentVisibility === "hidden" || /paint|content|strict/.test(style.contain ?? "");
        if (!clipsItself && box instanceof HTMLElement && box.localName !== "select") {
          walk(box);
        }
      }
    };
    walk(visual2);
    return { left: -start, right: end - visual2.clientWidth };
  }
  function scrollsWide(reach, frameWidth2, range, scrolling) {
    return reach.end > STICK_OUT_PX && // A wide element centred in the frame could only be scrolled to its end.
    reach.start <= STICK_OUT_PX && frameWidth2 + reach.end <= frameWidth2 * WIDEST_IN_FRAMES && range > STICK_OUT_PX && // Checked only to start, so a tooltip shown while the visual is scrolled does not snap it back.
    (scrolling || range <= reach.end + PARKED_PX && frameWidth2 + range <= frameWidth2 * WIDEST_IN_FRAMES);
  }
  function hiddenSides(scrollLeft, range, rtl) {
    const fromStart = Math.min(Math.abs(scrollLeft), range);
    const toEnd = range - fromStart;
    return rtl ? { left: toEnd, right: fromStart } : { left: fromStart, right: toEnd };
  }
  var wideVisual = document.getElementById("vis-container");
  var wideFinalRendered = false;
  var renderedDuringCopy = false;
  var FADE_PROPERTIES = ["--wide-fade-left", "--wide-fade-right"];
  function setStyle(visual2, name, value) {
    if (visual2.style.getPropertyValue(name) !== value) {
      visual2.style.setProperty(name, value);
    }
  }
  var isRtl = (visual2) => getComputedStyle(visual2).direction === "rtl";
  function showMore(visual2) {
    if (!visual2.classList.contains(SCROLLS)) {
      if (visual2.dataset.wideMore !== void 0) {
        delete visual2.dataset.wideMore;
      }
      for (const name of FADE_PROPERTIES) {
        visual2.style.removeProperty(name);
      }
      return;
    }
    const hidden = hiddenSides(
      visual2.scrollLeft,
      Math.max(0, visual2.scrollWidth - visual2.clientWidth),
      isRtl(visual2)
    );
    const fade = (px2) => `${px2 > 1 ? Math.min(Math.round(px2), FADE_PX) : 0}px`;
    setStyle(visual2, "--wide-fade-left", fade(hidden.left));
    setStyle(visual2, "--wide-fade-right", fade(hidden.right));
    const more = hidden.left > 1 && hidden.right > 1 ? "both" : hidden.left > 1 ? "left" : hidden.right > 1 ? "right" : void 0;
    if (visual2.dataset.wideMore !== more) {
      if (more === void 0) {
        delete visual2.dataset.wideMore;
      } else {
        visual2.dataset.wideMore = more;
      }
    }
  }
  var FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), iframe, summary, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';
  function setScrolling(visual2, on) {
    if (on === visual2.classList.contains(SCROLLS)) {
      return;
    }
    visual2.classList.toggle(SCROLLS, on);
    if (on && !visual2.hasAttribute("tabindex") && !visual2.querySelector(FOCUSABLE)) {
      visual2.setAttribute("tabindex", "0");
      visual2.dataset.wideTabindex = "";
    } else if (!on && visual2.dataset.wideTabindex !== void 0) {
      if (visual2.getAttribute("tabindex") === "0") {
        visual2.removeAttribute("tabindex");
      }
      delete visual2.dataset.wideTabindex;
    }
  }
  function startAfresh(visual2) {
    if (visual2.classList.contains(SCROLLS)) {
      visual2.scrollLeft = 0;
      setScrolling(visual2, false);
    }
  }
  function measureWidth() {
    if (!wideVisual || !wideFinalRendered || // copyEnds measures once the copy is done.
    wideVisual.classList.contains(WHOLE_WIDTH)) {
      return;
    }
    if (!document.documentElement.hasAttribute(HOST_ALLOWS)) {
      startAfresh(wideVisual);
      showMore(wideVisual);
      return;
    }
    if (
      // The full-screen View larger layout (open-larger.ts) zooms the visual and shows all of it; leaving it resizes the
      // frame, which measures again. A frame with no width (a closed pane) keeps where it was scrolled to.
      document.documentElement.hasAttribute("data-open-larger") || wideVisual.clientWidth === 0
    ) {
      return;
    }
    const scrolling = wideVisual.classList.contains(SCROLLS);
    const range = wideVisual.scrollWidth - wideVisual.clientWidth;
    const rtl = isRtl(wideVisual);
    const reach = range > STICK_OUT_PX ? flowReach(wideVisual) : { left: 0, right: 0 };
    const wide = scrollsWide(
      {
        end: rtl ? reach.left : reach.right,
        start: rtl ? reach.right : reach.left
      },
      wideVisual.clientWidth,
      range,
      scrolling
    );
    if (scrolling && !wide) {
      wideVisual.scrollLeft = 0;
    }
    setScrolling(wideVisual, wide);
    showMore(wideVisual);
  }
  var measureAsked = false;
  function askMeasure() {
    if (!measureAsked) {
      measureAsked = true;
      requestAnimationFrame(() => {
        measureAsked = false;
        measureWidth();
      });
    }
  }
  var wideResizes = typeof ResizeObserver === "undefined" ? void 0 : new ResizeObserver(askMeasure);
  window.addEventListener("viz:complete", () => {
    if (wideVisual) {
      if (wideVisual.classList.contains(WHOLE_WIDTH)) {
        renderedDuringCopy = true;
      } else {
        startAfresh(wideVisual);
      }
      wideResizes?.disconnect();
      wideResizes?.observe(wideVisual);
    }
    wideFinalRendered = true;
    measureWidth();
    void document.fonts?.ready.then(askMeasure);
    void Promise.allSettled(
      (document.getAnimations?.() ?? []).filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity
      ).map((animation) => animation.finished)
    ).then(askMeasure);
  });
  window.addEventListener("resize", askMeasure);
  wideVisual?.addEventListener("scroll", () => showMore(wideVisual), {
    passive: true
  });
  var copying = false;
  var copyEnds = typeof MutationObserver === "undefined" ? void 0 : new MutationObserver(() => {
    const was = copying;
    copying = wideVisual?.classList.contains(WHOLE_WIDTH) === true;
    if (!wideVisual || copying || !was) {
      return;
    }
    if (renderedDuringCopy) {
      renderedDuringCopy = false;
      startAfresh(wideVisual);
    }
    measureWidth();
  });
  if (wideVisual) {
    copyEnds?.observe(wideVisual, { attributeFilter: ["class"] });
  }
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(askMeasure).observe(document.documentElement, {
      attributeFilter: [HOST_ALLOWS]
    });
  }

  // src/scripts/menu-room.ts
  var GAP_PX = 4;
  var STEP_PX = 4;
  var NEAR_PX = 8;
  var MOST_TEXTS = 5e3;
  var UNDRAWN = /* @__PURE__ */ new Set(["script", "style", "template", "noscript", "title"]);
  var CLIPS = /^(hidden|clip|scroll|auto)$/;
  var HOST_ALLOWS2 = "data-keep-menu-clear";
  var ROOM = "data-menu-room";
  var ROOM_SIZE = "--menu-room";
  var QUIET = "data-quiet";
  var HELD = "data-menu-held";
  var HELD_SIZE = "--menu-held";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var CONTROLS = [
    "a[href]",
    "area[href]",
    "button",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "label",
    "[contenteditable]:not([contenteditable='false'])",
    "[tabindex]:not([tabindex^='-'])",
    "[onclick]",
    "[role='button']",
    "[role='checkbox']",
    "[role='combobox']",
    "[role='link']",
    "[role='menuitem']",
    "[role='option']",
    "[role='radio']",
    "[role='slider']",
    "[role='spinbutton']",
    "[role='switch']",
    "[role='tab']",
    "[role='textbox']"
  ].join(", ");
  function isControl(element) {
    return element.matches(CONTROLS) || getComputedStyle(element).cursor === "pointer";
  }
  function roomUnder(button, visual2) {
    const zone = new DOMRect(
      button.x - GAP_PX,
      button.y - GAP_PX,
      button.width + 2 * GAP_PX,
      button.height + 2 * GAP_PX
    );
    const tops = [
      ...controlsIn(zone, visual2).map(
        (control) => control.getBoundingClientRect().top
      ),
      ...textIn(zone, visual2).map((line2) => line2.top)
    ];
    return tops.length === 0 ? 0 : Math.max(0, Math.ceil(zone.bottom - Math.min(...tops)));
  }
  function controlsIn(zone, visual2) {
    const found = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    for (let y = zone.top; y <= zone.bottom; y += STEP_PX) {
      for (let x = zone.left; x <= zone.right; x += STEP_PX) {
        for (const element of document.elementsFromPoint(x, y)) {
          if (!seen.has(element) && element !== visual2 && visual2.contains(element)) {
            seen.add(element);
            if (isControl(element)) {
              found.add(element);
            }
          }
        }
      }
    }
    return [...found];
  }
  function textIn(zone, visual2) {
    const found = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(visual2, NodeFilter.SHOW_TEXT);
    for (let read = 0; read < MOST_TEXTS && walker.nextNode(); read++) {
      const text = walker.currentNode;
      const holder = text.parentElement;
      if (!holder || !text.nodeValue?.trim() || UNDRAWN.has(holder.localName)) {
        continue;
      }
      range.selectNodeContents(text);
      const lines = holder.namespaceURI === SVG_NS ? [holder.getBoundingClientRect()] : Array.from(range.getClientRects());
      for (const line2 of lines) {
        const shown = overlaps(line2, zone) ? shownPart(line2, holder, visual2) : null;
        if (shown && overlaps(shown, zone)) {
          found.push(line2);
        }
      }
    }
    return found;
  }
  function shownPart(box, holder, visual2) {
    if (holder.checkVisibility?.({
      opacityProperty: true,
      visibilityProperty: true
    }) === false) {
      return null;
    }
    let { left, top, right, bottom } = box;
    for (let at = holder; at; at = at === visual2 ? null : at.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(at);
      if (CLIPS.test(overflowX) || CLIPS.test(overflowY)) {
        const clip = at.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    return right - left > 1 && bottom - top > 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
  }
  function overlaps(a, b) {
    return a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  var root3 = document.documentElement;
  var group = document.getElementById("action-btns");
  var visual = document.getElementById("vis-container");
  var ownPadding;
  var added = 0;
  var followsFrame = false;
  var frameWidth = window.innerWidth;
  var frameHeight = window.innerHeight;
  var roomGrowths = 0;
  var lastRoomGrowth = -Infinity;
  var finalRendered2 = false;
  function makeRoom2() {
    if (!group || !visual || !finalRendered2 || followsFrame || !root3.hasAttribute(HOST_ALLOWS2) || group.hidden || root3.hasAttribute("data-open-larger") || getComputedStyle(group).display === "none") {
      return;
    }
    ownPadding ?? (ownPadding = parseFloat(getComputedStyle(document.body).paddingTop) || 0);
    const button = group.getBoundingClientRect();
    const most = Math.ceil(
      button.bottom + GAP_PX - document.body.getBoundingClientRect().top - ownPadding
    );
    if (added >= most) {
      return;
    }
    const next = Math.min(added + roomUnder(button, visual), most);
    if (next <= added) {
      return;
    }
    const overBefore = overBottom(visual);
    added = next;
    root3.style.setProperty(ROOM_SIZE, `${ownPadding + added}px`);
    root3.setAttribute(ROOM, "");
    if (overBottom(visual) > Math.max(0, overBefore) + 1) {
      stopFollowingFrame();
    }
  }
  function overBottom(visual2) {
    return visual2.getBoundingClientRect().top + visual2.scrollHeight - document.body.getBoundingClientRect().bottom;
  }
  var makeRoomAsked = false;
  function askMakeRoom() {
    if (!makeRoomAsked) {
      makeRoomAsked = true;
      requestAnimationFrame(() => {
        makeRoomAsked = false;
        makeRoom2();
      });
    }
  }
  var visualResizes = typeof ResizeObserver === "undefined" ? void 0 : new ResizeObserver(askMakeRoom);
  function stopFollowingFrame() {
    if (added > 0) {
      root3.style.setProperty(
        HELD_SIZE,
        `${document.body.getBoundingClientRect().height}px`
      );
      root3.setAttribute(HELD, "");
    }
    followsFrame = true;
    added = 0;
    root3.removeAttribute(ROOM);
    root3.style.removeProperty(ROOM_SIZE);
  }
  window.addEventListener("resize", () => {
    const grew = window.innerHeight - frameHeight;
    const sameWidth = window.innerWidth === frameWidth;
    frameWidth = window.innerWidth;
    frameHeight = window.innerHeight;
    if (sameWidth && added > 0 && Math.abs(grew - added) <= 1) {
      const now = performance.now();
      roomGrowths = now - lastRoomGrowth < 1e3 ? roomGrowths + 1 : 1;
      lastRoomGrowth = now;
      if (roomGrowths >= 3) {
        stopFollowingFrame();
      }
    } else {
      roomGrowths = 0;
    }
    askMakeRoom();
  });
  window.addEventListener("viz:complete", (event) => {
    finalRendered2 = true;
    const code = event.detail?.code;
    if (typeof code === "string" && sizedByViewport(code)) {
      stopFollowingFrame();
    }
    askMakeRoom();
    frameWidth = window.innerWidth;
    frameHeight = window.innerHeight;
    if (visual) {
      visualResizes?.disconnect();
      visualResizes?.observe(visual);
    }
    void document.fonts?.ready.then(askMakeRoom);
    void Promise.allSettled(
      (document.getAnimations?.() ?? []).filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity
      ).map((animation) => animation.finished)
    ).then(askMakeRoom);
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (root3.hasAttribute(HOST_ALLOWS2) && group && !group.hidden && visual && event.composedPath().includes(visual)) {
        group.setAttribute(QUIET, "");
      }
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!group?.hasAttribute(QUIET) || event.buttons !== 0) {
        return;
      }
      const { left, top, right, bottom } = group.getBoundingClientRect();
      if (event.clientX >= left - NEAR_PX && event.clientX <= right + NEAR_PX && event.clientY >= top - NEAR_PX && event.clientY <= bottom + NEAR_PX) {
        group.removeAttribute(QUIET);
      }
    },
    { capture: true, passive: true }
  );
  root3.addEventListener("pointerleave", () => group?.removeAttribute(QUIET));
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(askMakeRoom).observe(root3, {
      attributeFilter: [HOST_ALLOWS2]
    });
  }

  // src/scripts/widget-main.ts
  var hostApp4 = app;
  var IMPLEMENTATION = { name: "visualize widget", version: "1.0.0" };
  var container2 = document.getElementById("vis-container");
  function isSvgCode(code) {
    return code.trimStart().startsWith("<svg");
  }
  function hasSvgVisuals(code) {
    return code && /<(rect|circle|ellipse|line|polyline|polygon|path|text|image|use|g|foreignObject)[\s>]/i.test(
      code.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<defs[\s\S]*?<\/defs>/gi, "")
    );
  }
  function hasHtmlVisuals(code) {
    return code && code.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
  }
  function sendScriptEvent(event, data) {
    try {
      hostApp4.sendNotification({
        method: "notifications/message",
        params: {
          level: event.startsWith("hosted-copy-loaded:") ? "info" : "warning",
          logger: `viz:scripts:${event}`,
          data
        }
      });
    } catch {
    }
  }
  var copyFallbackReported = false;
  function reportHostedCopy(event, src) {
    if (!copyFallbackReported) {
      copyFallbackReported = event.startsWith("hosted-copy-fallback:");
      sendScriptEvent(event, { src });
    }
  }
  fetchMapDataFromCopies(
    (src) => reportHostedCopy("hosted-copy-fallback:maps", src)
  );
  watchIconFont((src) => reportHostedCopy("hosted-copy-fallback:icons", src));
  var JS_MIME_TYPES = /^(?:text\/(?:javascript(?:1\.[0-5])?|x-javascript|ecmascript|x-ecmascript|jscript|livescript)|application\/(?:javascript|x-javascript|ecmascript|x-ecmascript))$/;
  var VENDORED_LIBS = [
    {
      local: "/libs/chart.umd.js",
      major: 4,
      // vendored 4.3.3
      cdnjs: "Chart.js",
      npm: ["chart.js"],
      file: /^chart(\.umd)?(\.min)?\.js$/,
      bareMain: true
    },
    {
      local: "/libs/d3.min.js",
      major: 7,
      // vendored 7.8.5
      cdnjs: "d3",
      npm: ["d3"],
      file: /^d3(\.min)?\.js$/,
      bareMain: true
    },
    {
      local: "/libs/plotly.min.js",
      major: 2,
      // vendored 2.26.0; partial dist bundles get the full superset
      cdnjs: "plotly.js",
      npm: ["plotly.js", "plotly.js-dist", "plotly.js-dist-min"],
      file: /^plotly([.-][\w.]+)?(\.min)?\.js$/
    },
    {
      local: "/libs/papaparse.min.js",
      major: 5,
      // vendored 5.4.1
      cdnjs: "PapaParse",
      npm: ["papaparse"],
      file: /^papaparse(\.min)?\.js$/
    },
    {
      local: "/libs/imagine/topojson-client-3.1.0/topojson-client.min.js",
      major: 3,
      npm: ["topojson-client"],
      file: /^topojson-client(\.min)?\.js$/,
      bareMain: true
    },
    {
      local: "/libs/imagine/topojson-3.0.2/topojson.min.js",
      major: 3,
      // vendored 3.0.2, the full bundle
      cdnjs: "topojson",
      npm: ["topojson"],
      file: /^topojson(\.min)?\.js$/,
      bareMain: true
    }
  ];
  function parseCdnUrl(src) {
    let url;
    try {
      url = new URL(src);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") {
      return null;
    }
    const basename = url.pathname.split("/").pop() ?? "";
    let m = null;
    switch (url.hostname.toLowerCase()) {
      case "cdnjs.cloudflare.com":
        m = /^\/ajax\/libs\/([^/]+)\/(\d+)[\w.-]*\//.exec(url.pathname);
        return m ? { registry: "cdnjs", pkg: m[1], major: Number(m[2]), basename } : null;
      case "cdn.jsdelivr.net":
        m = /^\/npm\/((?:@[^/@]+\/)?[^/@]+)@(\d+)[\w.-]*(\/|$)/.exec(
          url.pathname
        );
        break;
      case "unpkg.com":
        m = /^\/((?:@[^/@]+\/)?[^/@]+)@(\d+)[\w.-]*(\/|$)/.exec(url.pathname);
        break;
      default:
        return null;
    }
    return m ? {
      registry: "npm",
      pkg: m[1],
      major: Number(m[2]),
      basename: m[3] === "/" ? basename : null
    } : null;
  }
  function vendoredLibSrc(src) {
    const parsed = parseCdnUrl(src);
    if (parsed === null) {
      return null;
    }
    for (const lib of VENDORED_LIBS) {
      const pkgMatches = parsed.registry === "cdnjs" ? parsed.pkg === lib.cdnjs : (lib.npm ?? []).includes(parsed.pkg);
      const fileMatches = parsed.basename === null ? lib.bareMain === true : lib.file.test(parsed.basename);
      if (pkgMatches && parsed.major === lib.major && fileMatches) {
        return lib.local;
      }
    }
    return null;
  }
  function cloneInertScript(source) {
    const el = document.createElement("script");
    Array.from(source.attributes).forEach(
      (attr) => el.setAttribute(attr.name, attr.value)
    );
    el.textContent = source.textContent;
    el.dataset.executed = "";
    return el;
  }
  function awaitLoad(el) {
    return new Promise((resolve) => {
      el.onload = () => resolve(true);
      el.onerror = () => resolve(false);
    });
  }
  async function executeScripts() {
    const phases = [
      container2.querySelectorAll(
        "script[src]:not([data-executed])"
      ),
      container2.querySelectorAll(
        "script:not([src]):not([data-executed])"
      )
    ].map((list) => Array.from(list));
    preloadMermaidCopy(
      phases[1].filter((script) => script.type.trim().toLowerCase() === "module").map((script) => script.textContent ?? ""),
      reportHostedCopy
    );
    let runtimeErrorReported = false;
    const onScriptError = (event) => {
      if (runtimeErrorReported) {
        return;
      }
      runtimeErrorReported = true;
      sendScriptEvent("runtime-error", { message: String(event.message ?? "") });
    };
    window.addEventListener("error", onScriptError);
    try {
      for (const scripts of phases) {
        if (scripts === phases[1]) {
          try {
            applyHostTextSizeToCharts();
          } catch (err) {
            onScriptError(
              new ErrorEvent("error", {
                message: "chart text size: " + String(err)
              })
            );
          }
        }
        for (const oldScript of scripts) {
          if (!oldScript.isConnected) {
            sendScriptEvent("skipped-detached", {
              src: oldScript.getAttribute("src") ?? "",
              inline: !oldScript.hasAttribute("src")
            });
            continue;
          }
          const newScript = cloneInertScript(oldScript);
          const scriptType = (newScript.getAttribute("type") ?? "").trim().toLowerCase();
          const isClassic = scriptType === "" || JS_MIME_TYPES.test(scriptType);
          const text = newScript.textContent ?? "";
          if (scriptType === "module" && !newScript.hasAttribute("src") && importsMermaid(text)) {
            const place = document.createComment("");
            oldScript.replaceWith(place);
            void importMermaidFromCopy(text).catch(() => text).then((code) => {
              if (!place.isConnected) {
                sendScriptEvent("skipped-detached", { src: "", inline: true });
                return;
              }
              newScript.textContent = code;
              place.replaceWith(newScript);
            });
            continue;
          }
          const willLoad = newScript.hasAttribute("src") && (scriptType === "module" || isClassic && !newScript.hasAttribute("nomodule"));
          const originalSrc = newScript.getAttribute("src");
          const vendoredSrc = willLoad && isClassic && originalSrc !== null ? vendoredLibSrc(originalSrc) : null;
          if (vendoredSrc !== null) {
            newScript.setAttribute("src", vendoredSrc);
            newScript.removeAttribute("integrity");
            newScript.removeAttribute("crossorigin");
          }
          if (!willLoad) {
            oldScript.replaceWith(newScript);
            continue;
          }
          let pending = awaitLoad(newScript);
          oldScript.replaceWith(newScript);
          let lastSrc = newScript.src;
          let ok = await pending;
          if (!ok && vendoredSrc !== null && originalSrc !== null) {
            if (!newScript.isConnected) {
              sendScriptEvent("skipped-detached", {
                src: originalSrc,
                inline: false
              });
              continue;
            }
            sendScriptEvent("vendored-lib-fallback", { src: vendoredSrc });
            const cdnScript = cloneInertScript(oldScript);
            pending = awaitLoad(cdnScript);
            newScript.replaceWith(cdnScript);
            lastSrc = cdnScript.src;
            ok = await pending;
          }
          if (!ok) {
            sendScriptEvent(
              vendoredSrc !== null ? "load-error-after-fallback" : "load-error",
              { src: lastSrc }
            );
          }
        }
      }
    } finally {
      window.removeEventListener("error", onScriptError);
    }
  }
  var vizTitle = "visualize";
  var vizFinalized = false;
  var stalePartialSeen = false;
  var iframeStartTime = performance.now();
  var firstRenderSent = false;
  function sendTiming(event) {
    return hostApp4.sendNotification({
      method: "notifications/message",
      params: {
        level: "info",
        logger: `viz:timing:${event}`,
        data: { iframe_ms: Math.round(performance.now() - iframeStartTime) }
      }
    });
  }
  function sendAction(action) {
    return hostApp4.sendNotification({
      method: "notifications/message",
      params: { level: "info", logger: `viz:action:${action}`, data: { action } }
    });
  }
  function sendOutcome(outcome) {
    return hostApp4.sendNotification({
      method: "notifications/message",
      params: {
        level: "info",
        logger: `viz:outcome:${outcome}`,
        data: { outcome }
      }
    });
  }
  function markFirstRender() {
    if (!firstRenderSent) {
      firstRenderSent = true;
      sendTiming("firstrender");
    }
  }
  var svgRenderer = createStreamingRenderer({
    widgetName: "VisualizeWidget-SVG",
    shouldRender: (code) => !vizFinalized && hasSvgVisuals(code),
    onFirstRender: markFirstRender
  });
  var htmlRenderer = createStreamingRenderer({
    widgetName: "VisualizeWidget-HTML",
    stripScripts: true,
    shouldRender: (code) => !vizFinalized && hasHtmlVisuals(code),
    onFirstRender: markFirstRender
  });
  var finalRenders = 0;
  async function renderFinal(code) {
    const thisRender = ++finalRenders;
    container2.classList.remove("streaming");
    if (isSvgCode(code)) {
      if (hasSvgVisuals(code)) {
        container2.innerHTML = code;
        markFirstRender();
        void holdFrameSizedVisual(code);
        fixSvgTextEdgeClip(container2);
        fixSvgClipping(container2);
        fixSvgTextOcclusion(container2);
        scriptsRan();
      }
    } else {
      if (hasHtmlVisuals(code)) {
        container2.innerHTML = code;
        markFirstRender();
        await holdFrameSizedVisual(code);
        if (thisRender !== finalRenders) {
          return;
        }
        await executeScripts();
        scriptsRan();
        container2.classList.remove("scripts-loading");
        window._wireElicitation();
        fixSvgTextEdgeClip(container2);
        fixSvgClipping(container2);
        fixSvgTextOcclusion(container2);
      }
    }
    window.dispatchEvent(
      new CustomEvent("viz:complete", {
        detail: { code, title: vizTitle }
      })
    );
    sendTiming("complete");
  }
  function renderPartialCode(code) {
    container2.classList.add("streaming");
    if (isSvgCode(code)) {
      void svgRenderer.renderPartial(container2, code);
    } else {
      void htmlRenderer.renderPartial(container2, code);
      if (code.includes("<script") && hasHtmlVisuals(code)) {
        container2.classList.add("scripts-loading");
      }
    }
  }
  var nextRequestId = 1;
  var hostPlatform;
  var hostTakesDownloads = true;
  async function connectToHost() {
    try {
      window.addEventListener("message", (event) => {
        if (event.source !== proxyPage) {
          return;
        }
        try {
          const data = event.data;
          if (data && data.jsonrpc === "2.0") {
            if (data.id === 1 && data.result) {
              hostPlatform = data.result.hostContext?.platform;
              hostTakesDownloads = Boolean(
                data.result.hostCapabilities?.downloadFile
              );
              initHostContext(data.result);
              readWhetherHostCopiesText(data.result);
              readWhetherHostHandlesNotSent(data.result);
              proxyPage.postMessage(
                {
                  jsonrpc: "2.0",
                  method: "ui/notifications/initialized",
                  params: {}
                },
                "*"
              );
            }
          }
        } catch (err) {
          console.error("[VisualizeWidget] Error handling message:", err);
        }
      });
      hostApp4.onNotification("ui/notifications/tool-input-partial", (params) => {
        if (vizFinalized) {
          if (!stalePartialSeen) {
            stalePartialSeen = true;
            sendScriptEvent("stale-partial", {});
          }
          return;
        }
        const args = params?.arguments ?? {};
        if (typeof args.title === "string" && args.title) {
          vizTitle = args.title;
        }
        const code = args.widget_code ?? args.code;
        if (code) {
          renderPartialCode(code);
        }
      });
      hostApp4.onNotification("ui/notifications/tool-input", (params) => {
        const args = params?.arguments ?? {};
        if (typeof args.title === "string" && args.title) {
          vizTitle = args.title;
        }
        const code = args.widget_code ?? args.code;
        if (code) {
          vizFinalized = true;
          void renderFinal(code);
          if (!document.querySelector("form.elicit")) {
            document.getElementById("action-btns")?.removeAttribute("hidden");
          }
        }
      });
      proxyPage.postMessage(
        {
          jsonrpc: "2.0",
          id: nextRequestId++,
          method: "ui/initialize",
          params: {
            protocolVersion: "2025-11-21",
            appInfo: IMPLEMENTATION,
            appCapabilities: {}
          }
        },
        "*"
      );
      hostApp4.setupAutoResize();
      const hostStr = (key) => {
        const s = window.__hostStrings;
        const v = s?.[key];
        return typeof v === "string" && v.trim() ? v : void 0;
      };
      const FREEZE_PROPS = [
        "fill",
        "stroke",
        "color",
        "stroke-width",
        "stroke-dasharray",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "text-anchor",
        "dominant-baseline"
      ];
      const freezeSvgForDownload = () => {
        const live = container2.querySelector("svg");
        if (!live) {
          return null;
        }
        const clone = live.cloneNode(true);
        if (!clone.hasAttribute("xmlns")) {
          clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        }
        clone.style.removeProperty("max-width");
        clone.style.removeProperty("display");
        clone.style.removeProperty("margin-inline");
        const liveEls = live.querySelectorAll("*");
        const cloneEls = clone.querySelectorAll("*");
        const forceLight = document.createElement("style");
        forceLight.textContent = ":root, * { color-scheme: light !important; }";
        document.head.appendChild(forceLight);
        const root4 = document.documentElement;
        const prevMode = root4.getAttribute("data-mode");
        root4.setAttribute("data-mode", "light");
        try {
          for (let i = 0; i < liveEls.length; i++) {
            const el = liveEls[i];
            const out = cloneEls[i];
            if (el.closest("defs, marker, mask, clipPath, pattern, symbol")) {
              continue;
            }
            const cs = getComputedStyle(el);
            const decls = [];
            for (const p of FREEZE_PROPS) {
              const v = cs.getPropertyValue(p);
              if (!v) {
                continue;
              }
              if (v.startsWith("url(")) {
                continue;
              }
              if (v === "normal") {
                continue;
              }
              if (v === "none" && p === "stroke-dasharray") {
                continue;
              }
              decls.push(`${p}:${v}`);
            }
            if (decls.length) {
              const existing = out.getAttribute("style");
              out.setAttribute(
                "style",
                existing ? `${existing};${decls.join(";")}` : decls.join(";")
              );
            }
            out.removeAttribute("class");
          }
        } finally {
          forceLight.remove();
          if (prevMode === null) {
            root4.removeAttribute("data-mode");
          } else {
            root4.setAttribute("data-mode", prevMode);
          }
        }
        clone.querySelectorAll(EXECUTABLE_SELECTOR).forEach((n) => n.remove());
        scrubUrlAndHandlerAttrs(clone);
        const COPYABLE_DEF_TAGS = /* @__PURE__ */ new Set([
          "marker",
          "lineargradient",
          "radialgradient",
          "pattern",
          "clippath",
          "mask",
          "symbol",
          "filter"
        ]);
        const shellDefs = document.querySelector(
          "body > svg[aria-hidden] > defs"
        );
        const serialized = new XMLSerializer().serializeToString(clone);
        const refRe = /url\(\s*["']?\s*#([^"')\s]+)\s*["']?\s*\)/gi;
        const missing = /* @__PURE__ */ new Set();
        let refMatch;
        while (refMatch = refRe.exec(serialized)) {
          const id = refMatch[1];
          try {
            const match = clone.querySelector(`#${CSS.escape(id)}`);
            const shellSource = shellDefs?.querySelector(`#${CSS.escape(id)}`);
            if (!match || shellSource && match.tagName.toLowerCase() !== shellSource.tagName.toLowerCase()) {
              missing.add(id);
            }
          } catch {
          }
        }
        if (missing.size > 0 && shellDefs) {
          let copied = false;
          let defs = null;
          for (const id of missing) {
            let source = null;
            try {
              source = shellDefs.querySelector(`#${CSS.escape(id)}`);
            } catch {
              continue;
            }
            if (!source || !COPYABLE_DEF_TAGS.has(source.tagName.toLowerCase())) {
              continue;
            }
            if (!defs) {
              defs = clone.ownerDocument.createElementNS(
                "http://www.w3.org/2000/svg",
                "defs"
              );
              clone.insertBefore(defs, clone.firstChild);
            }
            const copy = source.cloneNode(true);
            copy.querySelectorAll(`${EXECUTABLE_SELECTOR}, foreignObject`).forEach((n) => n.remove());
            scrubUrlAndHandlerAttrs(copy);
            defs.appendChild(copy);
            copied = true;
          }
          if (copied) {
            return new XMLSerializer().serializeToString(clone);
          }
        }
        return serialized;
      };
      const PNG_EXPORT_SCALE = 4;
      const PNG_MAX_DIMENSION = 8192;
      const PNG_MAX_AREA = 16e6;
      let foInImageSupport = null;
      const foreignObjectRendersInImage = async () => {
        if (foInImageSupport !== null) {
          return foInImageSupport;
        }
        try {
          const probe = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><foreignObject width="2" height="2"><div xmlns="http://www.w3.org/1999/xhtml" style="width:2px;height:2px;background:#f00"></div></foreignObject></svg>';
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("probe failed to load"));
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(probe)}`;
          });
          const c = document.createElement("canvas");
          c.width = 2;
          c.height = 2;
          const cx = c.getContext("2d");
          if (!cx) {
            return false;
          }
          cx.drawImage(img, 0, 0);
          try {
            foInImageSupport = cx.getImageData(0, 0, 1, 1).data[3] > 0;
            return foInImageSupport;
          } catch {
            foInImageSupport = false;
            return foInImageSupport;
          }
        } catch {
          return false;
        }
      };
      class NoPng extends Error {
        constructor(why, anotherTryMayWork = false) {
          super(why);
          this.why = why;
          this.anotherTryMayWork = anotherTryMayWork;
        }
      }
      const exportSvgAsPng = async () => {
        const live = container2.querySelector("svg");
        if (!live) {
          throw new NoPng("no_drawing");
        }
        if (hasUnrasterizableRef(live)) {
          throw new NoPng("external_reference");
        }
        const frozen = freezeSvgForDownload();
        if (!frozen) {
          throw new NoPng("no_drawing");
        }
        const vb = live.viewBox?.baseVal;
        let width = vb && vb.width > 0 ? vb.width : 0;
        let height = vb && vb.height > 0 ? vb.height : 0;
        if (!width || !height) {
          const attrPx = (name) => {
            const raw = (live.getAttribute(name) ?? "").trim();
            return /^\d*\.?\d+(px)?$/i.test(raw) ? parseFloat(raw) : 0;
          };
          const wAttr = attrPx("width");
          const hAttr = attrPx("height");
          if (wAttr > 0 && hAttr > 0) {
            width = wAttr;
            height = hAttr;
          }
        }
        if (!width || !height) {
          const rect = live.getBoundingClientRect();
          width = rect.width;
          height = rect.height;
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new NoPng("no_size");
        }
        const scale = Math.min(
          PNG_EXPORT_SCALE,
          PNG_MAX_DIMENSION / width,
          PNG_MAX_DIMENSION / height,
          Math.sqrt(PNG_MAX_AREA / (width * height))
        );
        const outWidth = Math.max(1, Math.round(width * scale));
        const outHeight = Math.max(1, Math.round(height * scale));
        const doc = new DOMParser().parseFromString(frozen, "image/svg+xml");
        if (doc.getElementsByTagNameNS(
          "http://www.mozilla.org/newlayout/xml/parsererror.xml",
          "parsererror"
        ).length > 0 || doc.getElementsByTagNameNS(
          "http://www.w3.org/1999/xhtml",
          "parsererror"
        ).length > 0) {
          throw new NoPng("does_not_parse");
        }
        if (doc.getElementsByTagName("foreignObject").length > 0 && !await foreignObjectRendersInImage()) {
          if (foInImageSupport !== false) {
            throw new NoPng("labels_unchecked", true);
          }
          throw new NoPng("labels_unsupported");
        }
        const root4 = doc.documentElement;
        if (!root4.getAttribute("viewBox")) {
          root4.setAttribute("viewBox", `0 0 ${width} ${height}`);
        }
        const rootStyle = root4.style;
        for (const prop of [
          "width",
          "height",
          "min-width",
          "min-height",
          "max-width",
          "max-height",
          "inline-size",
          "block-size",
          "min-inline-size",
          "min-block-size",
          "max-inline-size",
          "max-block-size",
          "aspect-ratio"
        ]) {
          rootStyle.removeProperty(prop);
        }
        root4.setAttribute("width", String(outWidth));
        root4.setAttribute("height", String(outHeight));
        const sized = new XMLSerializer().serializeToString(root4);
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new NoPng("image_not_loaded"));
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
        });
        const canvas = document.createElement("canvas");
        canvas.width = outWidth;
        canvas.height = outHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new NoPng("no_canvas", true);
        }
        ctx.drawImage(img, 0, 0, outWidth, outHeight);
        const pngBlob = await new Promise(
          (resolve) => canvas.toBlob(resolve, "image/png")
        );
        if (!pngBlob) {
          throw new NoPng("no_png_file");
        }
        return blobToBase64(pngBlob);
      };
      const downloadBtn = document.getElementById("download-btn");
      const downloadIconEl = document.getElementById("download-icon");
      const downloadLabelEl = downloadBtn?.querySelector(".more-item-label");
      const downloadIcon = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M16.5 13C16.7761 13 17 13.2239 17 13.5V15.5C17 16.3284 16.3284 17 15.5 17H4.5C3.67157 17 3 16.3284 3 15.5V13.5C3 13.2239 3.22386 13 3.5 13C3.77614 13 4 13.2239 4 13.5V15.5C4 15.7761 4.22386 16 4.5 16H15.5C15.7761 16 16 15.7761 16 15.5V13.5C16 13.2239 16.2239 13 16.5 13ZM10 3C10.2761 3 10.5 3.22386 10.5 3.5V12.1855L13.626 8.66797C13.8094 8.46166 14.1256 8.44275 14.332 8.62598C14.5383 8.80936 14.5573 9.12563 14.374 9.33203L10.374 13.832L10.2949 13.9033C10.21 13.9654 10.107 14 10 14C9.85718 14 9.72086 13.9388 9.62598 13.832L5.62598 9.33203L5.56738 9.25C5.45079 9.04872 5.48735 8.78653 5.66797 8.62598C5.84854 8.46567 6.1127 8.46039 6.29883 8.59961L6.37402 8.66797L9.5 12.1855V3.5C9.5 3.22386 9.72386 3 10 3Z"/></svg>';
      const downloadCheckIcon = '<svg width="20" height="20" viewBox="0 0 20 20" fill="var(--text-success)"><path d="M15.1883 5.10908C15.3699 4.96398 15.6346 4.96153 15.8202 5.11592C16.0056 5.27067 16.0504 5.53125 15.9403 5.73605L15.8836 5.82003L8.38354 14.8202C8.29361 14.9279 8.16242 14.9925 8.02221 14.9989C7.88203 15.0051 7.74545 14.9526 7.64622 14.8534L4.14617 11.3533L4.08172 11.2752C3.95384 11.0811 3.97542 10.817 4.14617 10.6463C4.31693 10.4755 4.58105 10.4539 4.77509 10.5818L4.85321 10.6463L7.96556 13.7586L15.1161 5.1794L15.1883 5.10908Z"/></svg>';
      if (downloadIconEl) {
        downloadIconEl.innerHTML = downloadIcon;
      }
      const pngBtn = document.getElementById("png-btn");
      const pngIconEl = document.getElementById("png-icon");
      const pngLabelEl = pngBtn?.querySelector(".more-item-label");
      if (pngIconEl) {
        pngIconEl.innerHTML = downloadIcon;
      }
      const toastEl = document.getElementById("copy-toast");
      let toastTimer;
      const showToast = (msg) => {
        toastEl.textContent = msg;
        toastEl.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 3e3);
      };
      const showDownloadFailed = (anotherTryMayWork) => showToast(
        anotherTryMayWork ? hostStr("grabRetry") ?? "Couldn\u2019t download image. Try again." : hostStr("grabRefused") ?? "Couldn\u2019t download image.\nTake a screenshot instead."
      );
      const tellDownloadEnded = (outcome) => {
        try {
          sendOutcome(outcome);
        } catch {
        }
      };
      let downloadInFlight = false;
      let downloadEpoch = 0;
      let downloadGuardTimer;
      const acquireDownload = () => {
        if (downloadInFlight) {
          return null;
        }
        downloadInFlight = true;
        const epoch = ++downloadEpoch;
        clearTimeout(downloadGuardTimer);
        downloadGuardTimer = setTimeout(() => {
          if (epoch === downloadEpoch) {
            downloadInFlight = false;
          }
        }, 6e4);
        return epoch;
      };
      const releaseDownload = (epoch) => {
        if (epoch !== downloadEpoch) {
          return;
        }
        clearTimeout(downloadGuardTimer);
        downloadInFlight = false;
      };
      sendDownloadLinksToHost({
        acquireDownload,
        releaseDownload,
        countPress: () => sendAction("download_link")
      });
      let pngRestoreTimer;
      let downloadRestoreTimer;
      let copyRestoreTimer;
      let vizRenderEpoch = 0;
      window.addEventListener("viz:complete", (ev) => {
        const renderEpoch = ++vizRenderEpoch;
        const detail = ev.detail;
        const code = detail?.code;
        const title = detail?.title || "visualize";
        if (!code || !downloadBtn || !downloadIconEl || !downloadLabelEl) {
          return;
        }
        const safeTitle = fileNameForUri(title, "visualize");
        const isSvg = code.trimStart().startsWith("<svg");
        const ext = isSvg ? "svg" : "html";
        const mime = isSvg ? "image/svg+xml" : "text/html";
        const hasRenderedSvg = !!container2.querySelector("svg") && !!hasSvgVisuals(code);
        const liveSvgEl = container2.querySelector("svg");
        const pngExportable = hostTakesDownloads && hasRenderedSvg && !!liveSvgEl && !hasUnrasterizableRef(liveSvgEl);
        const labelHost = downloadLabelEl;
        if (isSvg) {
          labelHost.dataset.i18n = "grabSvgLabel";
          labelHost.textContent = hostStr("grabSvgLabel") ?? "Download as SVG";
        } else {
          labelHost.dataset.i18n = "grabLabel";
          labelHost.textContent = hostStr("grabLabel") ?? "Download as HTML";
        }
        if (isSvg && pngExportable) {
          pngBtn?.removeAttribute("hidden");
          if (liveSvgEl?.querySelector("foreignObject")) {
            void foreignObjectRendersInImage().then(() => {
              if (foInImageSupport === false && renderEpoch === vizRenderEpoch) {
                pngBtn?.setAttribute("hidden", "");
              }
            });
          }
        } else {
          pngBtn?.setAttribute("hidden", "");
        }
        const copyBtnEl = document.getElementById("copy-btn");
        const nothingToExport = isSvg && !hasRenderedSvg;
        downloadBtn.toggleAttribute(
          "hidden",
          nothingToExport || !hostTakesDownloads
        );
        copyBtnEl?.toggleAttribute("hidden", nothingToExport);
        if (isSvg && pngExportable && pngBtn && pngIconEl && pngLabelEl) {
          pngBtn.onclick = async () => {
            const epoch = acquireDownload();
            if (epoch === null) {
              return;
            }
            try {
              let pngBase64 = null;
              let failure = null;
              let retried = false;
              try {
                sendAction("download_png");
                pngBase64 = await exportSvgAsPng().catch((error) => {
                  if (error instanceof NoPng && error.anotherTryMayWork && renderEpoch === vizRenderEpoch) {
                    retried = true;
                    return exportSvgAsPng();
                  }
                  throw error;
                });
              } catch (error) {
                failure = error instanceof NoPng ? error : new NoPng("unforeseen");
              }
              if (renderEpoch !== vizRenderEpoch) {
                pngBase64 = null;
                failure = new NoPng("redrawn", true);
              }
              if (!pngBase64) {
                failure ?? (failure = new NoPng("no_png_file"));
                tellDownloadEnded(`download_png_failed_${failure.why}`);
                showDownloadFailed(failure.anotherTryMayWork);
                return;
              }
              tellDownloadEnded(
                retried ? "download_png_handed_to_host_on_retry" : "download_png_handed_to_host"
              );
              try {
                const res = await hostApp4.sendRequest({
                  method: "ui/download-file",
                  params: {
                    contents: [
                      {
                        type: "resource",
                        resource: {
                          uri: `file:///${safeTitle}.png`,
                          mimeType: "image/png",
                          blob: pngBase64
                        }
                      }
                    ]
                  }
                });
                if (!res?.isError) {
                  const pngLabelHost = pngLabelEl;
                  pngIconEl.innerHTML = downloadCheckIcon;
                  delete pngLabelHost.dataset.i18n;
                  pngLabelHost.textContent = hostStr("grabDone") ?? "Downloaded";
                  clearTimeout(pngRestoreTimer);
                  pngRestoreTimer = setTimeout(() => {
                    pngIconEl.innerHTML = downloadIcon;
                    pngLabelHost.dataset.i18n = "pngLabel";
                    pngLabelHost.textContent = hostStr("pngLabel") ?? "Download as PNG";
                  }, 1500);
                }
              } catch {
              }
            } finally {
              releaseDownload(epoch);
            }
          };
        }
        downloadBtn.onclick = async () => {
          const epoch = acquireDownload();
          if (epoch === null) {
            return;
          }
          let handedToHost = false;
          try {
            sendAction("download");
            let text;
            if (isSvg) {
              const frozen = freezeSvgForDownload();
              if (!frozen) {
                tellDownloadEnded("download_svg_failed_no_drawing");
                showDownloadFailed(false);
                return;
              }
              text = frozen;
            } else {
              text = standalonePage(code);
            }
            tellDownloadEnded(
              isSvg ? "download_svg_handed_to_host" : "download_html_handed_to_host"
            );
            handedToHost = true;
            const res = await hostApp4.sendRequest({
              method: "ui/download-file",
              params: {
                contents: [
                  {
                    type: "resource",
                    resource: {
                      uri: `file:///${safeTitle}.${ext}`,
                      mimeType: mime,
                      text
                    }
                  }
                ]
              }
            });
            if (!res?.isError) {
              downloadIconEl.innerHTML = downloadCheckIcon;
              delete labelHost.dataset.i18n;
              labelHost.textContent = hostStr("grabDone") ?? "Downloaded";
              clearTimeout(downloadRestoreTimer);
              downloadRestoreTimer = setTimeout(() => {
                downloadIconEl.innerHTML = downloadIcon;
                const key = isSvg ? "grabSvgLabel" : "grabLabel";
                labelHost.dataset.i18n = key;
                labelHost.textContent = hostStr(key) ?? (isSvg ? "Download as SVG" : "Download as HTML");
              }, 1500);
            }
          } catch {
            if (!handedToHost) {
              tellDownloadEnded(
                isSvg ? "download_svg_failed_unforeseen" : "download_html_failed_unforeseen"
              );
            }
          } finally {
            releaseDownload(epoch);
          }
        };
      });
      const moreGroup = document.getElementById("action-btns");
      const morePopover = document.getElementById("more-popover");
      if (moreGroup && morePopover) {
        document.getElementById("more-btn")?.addEventListener("pointerenter", () => {
          if (!morePopover.querySelector(".more-item-label:not([data-i18n])")) {
            placeMoreMenu(moreGroup, morePopover);
          }
        });
      }
      const copyBtn = document.getElementById("copy-btn");
      const copyIconEl = document.getElementById("copy-icon");
      const copyLabelEl = copyBtn?.querySelector(".more-item-label");
      const copyIcon = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M12.5 3C13.3284 3 14 3.67157 14 4.5V6H15.5C16.3284 6 17 6.67157 17 7.5V15.5C17 16.3284 16.3284 17 15.5 17H7.5C6.67157 17 6 16.3284 6 15.5V14H4.5C3.67157 14 3 13.3284 3 12.5V4.5C3 3.67157 3.67157 3 4.5 3H12.5ZM14 12.5C14 13.3284 13.3284 14 12.5 14H7V15.5C7 15.7761 7.22386 16 7.5 16H15.5C15.7761 16 16 15.7761 16 15.5V7.5C16 7.22386 15.7761 7 15.5 7H14V12.5ZM4.5 4C4.22386 4 4 4.22386 4 4.5V12.5C4 12.7761 4.22386 13 4.5 13H12.5C12.7761 13 13 12.7761 13 12.5V4.5C13 4.22386 12.7761 4 12.5 4H4.5Z"/></svg>';
      const copyCheckIcon = '<svg width="20" height="20" viewBox="0 0 20 20" fill="var(--text-success)"><path d="M15.1883 5.10908C15.3699 4.96398 15.6346 4.96153 15.8202 5.11592C16.0056 5.27067 16.0504 5.53125 15.9403 5.73605L15.8836 5.82003L8.38354 14.8202C8.29361 14.9279 8.16242 14.9925 8.02221 14.9989C7.88203 15.0051 7.74545 14.9526 7.64622 14.8534L4.14617 11.3533L4.08172 11.2752C3.95384 11.0811 3.97542 10.817 4.14617 10.6463C4.31693 10.4755 4.58105 10.4539 4.77509 10.5818L4.85321 10.6463L7.96556 13.7586L15.1161 5.1794L15.1883 5.10908Z"/></svg>';
      if (copyIconEl) {
        copyIconEl.innerHTML = copyIcon;
      }
      if (copyBtn && copyIconEl && copyLabelEl) {
        const showCopyFailed = (outcome) => showToast(
          outcome === "copy_refused" ? hostStr("clipRefused") ?? "Couldn\u2019t copy image.\nTake a screenshot instead." : hostStr("clipFailed") ?? "Couldn\u2019t copy image. Try again."
        );
        const copyLabelHost = copyLabelEl;
        const actionBtns = document.getElementById("action-btns");
        const copyIconSvg = copyIconEl.firstElementChild;
        const showCopyIdle = () => {
          if (copyIconSvg) {
            copyIconEl.replaceChildren(copyIconSvg);
          }
          copyLabelHost.dataset.i18n = "clipLabel";
          copyLabelHost.textContent = hostStr("clipLabel") ?? "Copy as image";
          actionBtns?.removeAttribute("data-hold-open");
        };
        let copyWorking = false;
        let copyEpoch = 0;
        let copyGiveUpTimer;
        const stopCopyWorking = (epoch) => {
          if (epoch !== copyEpoch) {
            return false;
          }
          clearTimeout(copyGiveUpTimer);
          copyWorking = false;
          copyBtn.removeAttribute("aria-busy");
          copyBtn.removeAttribute("aria-disabled");
          return true;
        };
        const startCopyWorking = () => {
          if (copyWorking) {
            return null;
          }
          copyWorking = true;
          const epoch = ++copyEpoch;
          copyGiveUpTimer = setTimeout(() => {
            if (stopCopyWorking(epoch)) {
              showCopyIdle();
            }
          }, 6e4);
          clearTimeout(copyRestoreTimer);
          copyBtn.setAttribute("aria-busy", "true");
          copyBtn.setAttribute("aria-disabled", "true");
          actionBtns?.setAttribute("data-hold-open", "");
          delete copyLabelHost.dataset.i18n;
          copyLabelHost.textContent = hostStr("clipBusy") ?? "Copying\u2026";
          return epoch;
        };
        copyBtn.onclick = async () => {
          const epoch = startCopyWorking();
          if (epoch === null) {
            return;
          }
          try {
            sendAction("copy");
            const outcome = await copyToClipboard(hostPlatform).catch(
              () => "copy_failed_render"
            );
            try {
              sendOutcome(outcome);
            } catch {
            }
            if (!stopCopyWorking(epoch)) {
              return;
            }
            if (outcome !== "copy_done" && outcome !== "copy_done_via_host") {
              showCopyIdle();
              showCopyFailed(outcome);
              return;
            }
            copyIconEl.innerHTML = copyCheckIcon;
            delete copyLabelHost.dataset.i18n;
            copyLabelHost.textContent = hostStr("clipDone") ?? "Copied";
            actionBtns?.setAttribute("data-hold-open", "");
            clearTimeout(copyRestoreTimer);
            copyRestoreTimer = setTimeout(showCopyIdle, 1500);
          } catch {
            if (stopCopyWorking(epoch)) {
              showCopyIdle();
              showCopyFailed();
            }
          }
        };
      }
    } catch (err) {
      console.error("[VisualizeWidget] Failed to connect:", err);
    }
  }
  connectToHost();
})();

  </script>
</body>
</html>