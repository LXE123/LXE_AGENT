import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandMark } from "../../src/shared/ui/brand-mark";

describe("BrandMark", () => {
  test("renders the approved local application logo", () => {
    const labelled = renderToStaticMarkup(<BrandMark title="LXE Agent" />);
    const decorative = renderToStaticMarkup(<BrandMark />);

    expect(labelled).toContain("<img");
    expect(labelled).toContain("lxe-agent-logo.png");
    expect(labelled).toContain('alt="LXE Agent"');
    expect(decorative).toContain('alt=""');
    expect(decorative).toContain('aria-hidden="true"');
    expect(`${labelled}${decorative}`).not.toContain("<svg");
  });
});
