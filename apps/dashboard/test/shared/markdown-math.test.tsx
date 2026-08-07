import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from "../../src/shared/ui/markdown";

// Not String.raw: the transpiler rewrites non-ASCII characters to \uXXXX
// escapes, and String.raw hands back that escaped source verbatim, so any
// Chinese in the template would arrive as the literal text "补".
const render = (markdown: string): string => renderToStaticMarkup(
  <ReactMarkdown
    components={markdownComponents}
    rehypePlugins={markdownRehypePlugins}
    remarkPlugins={markdownRemarkPlugins}
  >
    {markdown}
  </ReactMarkdown>,
);

describe("conversation markdown math", () => {
  // A lone `$` cannot be told apart from money, and this agent writes about
  // money constantly.
  test("leaves prices alone", () => {
    const markup = render("采购单价 $4.50，运费 $12.80，合计 $17.30。");

    expect(markup).toContain("$4.50");
    expect(markup).toContain("$12.80");
    expect(markup).toContain("$17.30");
    expect(markup).not.toContain("katex");
  });

  test("leaves single-dollar math as the text it was typed as", () => {
    const markup = render("质能方程 $E = mc^2$ 就这样。");

    expect(markup).toContain("$E = mc^2$");
    expect(markup).not.toContain("katex");
  });

  test("centres a formula that stands alone, even written on one line", () => {
    const markup = render("$$ \\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi} $$");

    expect(markup).toContain("katex-display");
    // The lift rewrites the node, and an mdast node the hast conversion does
    // not recognise loses its value silently — the formula has to survive.
    expect(markup).toContain("\\int");
    expect(markup).toContain("\\sqrt");
  });

  test("keeps a formula inline when it sits inside a sentence", () => {
    const markup = render("补货点 $$R = d \\times L$$ 由提前期决定。");

    expect(markup).toContain("katex");
    expect(markup).not.toContain("katex-display");
    expect(markup).toContain("补货点");
    expect(markup).toContain("由提前期决定。");
  });

  // Swallowing a parse failure would leave the reader with a blank where the
  // formula was, and no way to tell that anything went wrong.
  test("shows a formula it cannot parse instead of dropping it", () => {
    const markup = render("$$ \\frac{1}{\\notacommand} $$");

    expect(markup).toContain("notacommand");
    expect(markup).toContain("#cc0000");
  });
});
