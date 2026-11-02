import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Options } from "react-markdown";

/**
 * `$$…$$` is typeset; a lone `$` is left alone.
 *
 * Single-dollar math cannot be told apart from money, and money is most of what
 * this agent writes about: "单价 $4.50，运费 $12.80" would have everything
 * between the two amounts swallowed and set as an equation. A formula is rare
 * here and a price is not, so the ambiguous delimiter goes to the price.
 */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

const isBlank = (node: MarkdownNode): boolean =>
  node.type === "text" && (node.value ?? "").trim() === "";

/**
 * Sets a formula written on one line as a centred block.
 *
 * remark-math only opens display math when `$$` stands alone on its own line;
 * written as `$$ … $$` the formula falls back to text math and ends up running
 * inline with the sentence. Models write it on one line all the time. Since
 * single-`$` math is off, every text-math node here necessarily came from `$$`,
 * so a paragraph holding nothing else is the block form on one line.
 */
function liftSingleLineDisplayMath() {
  const lift = (node: MarkdownNode): MarkdownNode => {
    if (!node.children) return node;
    node.children = node.children.map(lift).map((child) => {
      if (child.type !== "paragraph" || !child.children) return child;
      const content = child.children.filter((item) => !isBlank(item));
      const [only] = content;
      if (content.length !== 1 || only?.type !== "inlineMath") return child;
      const value = only.value ?? "";
      // The hast shape has to be spelled out: a bare `math` node carries its
      // formula in `value`, and the mdast-to-hast fallback drops the value of a
      // node type it does not know, which would delete the equation outright.
      // `math-display` is also the hook rehype-katex reads to centre it.
      return {
        type: "math",
        value,
        data: {
          hName: "div",
          hProperties: { className: ["math", "math-display"] },
          hChildren: [{ type: "text", value }],
        },
      };
    });
    return node;
  };
  return lift;
}

export const markdownRemarkPlugins: NonNullable<Options["remarkPlugins"]> = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  liftSingleLineDisplayMath,
];
