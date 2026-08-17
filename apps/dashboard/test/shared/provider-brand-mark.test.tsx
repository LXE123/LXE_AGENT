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
    expect(providerBrandKind("unknown_provider")).toBe("generic");
    expect(providerBrandKind("unknown-provider")).toBe("generic");
  });

  test("renders the bundled Kimi icon with local vectors and a generic fallback", () => {
    const kimi = renderToStaticMarkup(<ProviderBrandMark provider="kimi_coding" />);
    const deepseek = renderToStaticMarkup(<ProviderBrandMark provider="deepseek" />);
    const fallback = renderToStaticMarkup(<ProviderBrandMark provider="unknown_provider" />);

    expect(kimi).toContain('data-provider-mark="kimi"');
    expect(kimi).toContain('aria-hidden="true"');
    expect(kimi).toContain("<img");
    expect(kimi).toContain("kimi-icon-round.png");
    expect(kimi).not.toContain("provider-brand-orbit");
    expect(kimi).not.toContain("provider-brand-scan");
    expect(deepseek).toContain('data-provider-mark="deepseek"');
    expect(fallback).toContain('data-provider-mark="generic"');
    expect(fallback).toContain("lucide-brain");
    expect(`${kimi}${deepseek}`).not.toMatch(/https?:\/\//u);
  });

  test("keeps the Kimi icon scalable at compact status sizes", () => {
    for (const size of [16, 20, 24]) {
      const kimi = renderToStaticMarkup(<ProviderBrandMark provider="kimi-code" size={size} />);

      expect(kimi).toContain(`width:${size}px`);
      expect(kimi).toContain(`height:${size}px`);
      expect(kimi).toContain("<img");
    }
  });
});
