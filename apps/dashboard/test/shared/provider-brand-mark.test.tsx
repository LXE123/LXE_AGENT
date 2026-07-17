import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ProviderBrandMark,
  providerBrandKind,
} from "../../src/shared/ui/provider-brand-mark";

describe("ProviderBrandMark", () => {
  test("normalizes supported provider aliases", () => {
    expect(providerBrandKind("kimi_coding")).toBe("kimi");
    expect(providerBrandKind("kimi-coding")).toBe("kimi");
    expect(providerBrandKind("deep_seek")).toBe("deepseek");
    expect(providerBrandKind("deep-seek")).toBe("deepseek");
    expect(providerBrandKind("glm")).toBe("generic");
    expect(providerBrandKind("unknown-provider")).toBe("generic");
  });

  test("renders local decorative vectors with a generic fallback", () => {
    const kimi = renderToStaticMarkup(<ProviderBrandMark provider="kimi_coding" />);
    const deepseek = renderToStaticMarkup(<ProviderBrandMark provider="deepseek" />);
    const fallback = renderToStaticMarkup(<ProviderBrandMark provider="glm" />);

    expect(kimi).toContain('data-provider-mark="kimi"');
    expect(kimi).toContain('aria-hidden="true"');
    expect(kimi).toContain('class="provider-brand-orbit"');
    expect(kimi.match(/class="provider-brand-scan"/gu)).toHaveLength(3);
    expect(kimi).toContain('class="provider-brand-pulse"');
    expect(deepseek).toContain('data-provider-mark="deepseek"');
    expect(fallback).toContain('data-provider-mark="generic"');
    expect(fallback).toContain("lucide-brain");
    expect(`${kimi}${deepseek}`).not.toMatch(/<img|https?:\/\//u);
  });

  test("keeps the Kimi lunar mark scalable at compact status sizes", () => {
    for (const size of [16, 20, 24]) {
      const kimi = renderToStaticMarkup(<ProviderBrandMark provider="kimi-code" size={size} />);

      expect(kimi).toContain(`width:${size}px`);
      expect(kimi).toContain(`height:${size}px`);
      expect(kimi).toContain('viewBox="0 0 24 24"');
    }
  });
});
