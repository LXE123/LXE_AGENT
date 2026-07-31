import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DEFAULT_DASHBOARD_THEME,
  isDashboardTheme,
  resolveTheme,
} from "../../src/shared/appearance";

const styles = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");

function tokens(selector: string): Record<string, string> {
  const block = styles.slice(styles.indexOf(`${selector} {`));
  const body = block.slice(0, block.indexOf("\n}"));
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  );
}

const luminance = (hex: string): number => {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(parseInt(hex.slice(1, 3), 16))
    + 0.7152 * channel(parseInt(hex.slice(3, 5), 16))
    + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("theme preference", () => {
  test("system follows the OS and an explicit choice overrides it", () => {
    expect(DEFAULT_DASHBOARD_THEME).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(isDashboardTheme("dark")).toBe(true);
    expect(isDashboardTheme("sepia")).toBe(false);
    expect(isDashboardTheme(null)).toBe(false);
  });
});

describe("dark palette", () => {
  const light = tokens(":root");
  const dark = tokens(':root[data-theme="dark"]');

  test("keeps the light page plane ten percent closer to white without changing dark mode", () => {
    expect(light["--bg"]).toBe("#fbf9f6");
    expect(dark["--bg"]).toBe("#242322");
  });

  test("defines a dark value for every themeable light token", () => {
    // Guards the real failure mode: adding a token to :root and forgetting the
    // dark half, which silently leaves a light colour on a dark page.
    const skip = new Set(["--assistant-content-width"]);
    const missing = Object.keys(light).filter((name) => !skip.has(name) && !(name in dark));
    expect(missing).toEqual([]);
    expect(Object.keys(dark).length).toBeGreaterThan(50);
  });

  test("keeps cards lighter than the plane in both themes", () => {
    // Elevation in dark mode comes from this step, not from shadows. Swapping
    // --bg and --surface would turn every card into a dent.
    expect(luminance(light["--surface"])).toBeGreaterThan(luminance(light["--bg"]));
    expect(luminance(dark["--surface"])).toBeGreaterThan(luminance(dark["--bg"]));
  });

  test("keeps the sidebar below the content plane in dark mode", () => {
    const sidebar = tokens(':root[data-theme="dark"] .app-sidebar');
    expect(luminance(sidebar["--sidebar-bg"])).toBeLessThan(luminance(dark["--bg"]));
  });

  test("keeps the main dark planes out of the near-black range", () => {
    const sidebar = tokens(':root[data-theme="dark"] .app-sidebar');
    expect(luminance(dark["--bg"])).toBeGreaterThan(0.015);
    expect(luminance(sidebar["--sidebar-bg"])).toBeGreaterThan(0.01);
  });

  test("meets the light theme's own contrast on every text pair", () => {
    const pairs: ReadonlyArray<[string, string]> = [
      ["--text", "--bg"],
      ["--text", "--surface"],
      ["--text-soft", "--surface"],
      ["--muted", "--surface"],
      ["--accent-strong", "--surface"],
      ["--danger", "--surface"],
    ];
    for (const [fg, bg] of pairs) {
      expect(contrast(dark[fg], dark[bg])).toBeGreaterThanOrEqual(4.5);
    }
    // The quietest label is large-text only in both themes; it must not get
    // quieter than the light theme already is.
    expect(contrast(dark["--muted-light"], dark["--surface"]))
      .toBeGreaterThanOrEqual(contrast(light["--muted-light"], light["--surface"]));
  });

  test("keeps shadows quieter on dark than the light theme's alpha", () => {
    // A black shadow reads far more strongly against a dark plane. Carrying the
    // light theme's opacity over smears a halo around every raised element -
    // which is how the composer painted a band across the transcript.
    const alpha = (name: string, source: string): number => {
      const block = styles.slice(styles.indexOf(`${source} {`));
      const value = block.slice(0, block.indexOf("\n}"));
      const match = new RegExp(`${name}:\\s*rgba\\([^)]*?([\\d.]+)\\)`).exec(value);
      return Number(match?.[1] ?? NaN);
    };
    // The dark plane is ~14x darker, so the same alpha is nowhere near the same
    // apparent strength; it is capped rather than matched.
    expect(alpha("--shadow-soft", ':root[data-theme="dark"]')).toBeLessThanOrEqual(0.25);
    expect(alpha("--shadow-strong", ':root[data-theme="dark"]')).toBeLessThanOrEqual(0.5);
  });

  test("paints the transcript plane with --bg so cards have something to sit on", () => {
    // .conversation-view covers .content-panel-fill, so it - not the panel
    // beneath - is the plane the reader actually sees.
    expect(styles).toMatch(/\.conversation-view \{[^}]*background:\s*var\(--bg\)/s);
    expect(styles).not.toMatch(/\.conversation-view \{[^}]*background:\s*var\(--surface\)/s);
  });

  test("makes emphasis lighter on dark and darker on light", () => {
    expect(luminance(light["--accent-strong"])).toBeLessThan(luminance(light["--accent"]));
    expect(luminance(dark["--accent-strong"])).toBeGreaterThan(luminance(dark["--accent"]));
  });
});
