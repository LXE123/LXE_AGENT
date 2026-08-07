import React, { useEffect, useId, useMemo, useState } from "react";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Components, Options } from "react-markdown";

import "katex/dist/katex.min.css";
import { useUiText } from "../i18n";
import { CodeBlock } from "./code-block";

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

export const markdownRehypePlugins: NonNullable<Options["rehypePlugins"]> = [rehypeKatex];

const MERMAID_LANGUAGE_PATTERN = /\blanguage-mermaid\b/;
const CODE_LANGUAGE_PATTERN = /\blanguage-([^\s]+)\b/;

type MermaidApi = typeof import("mermaid").default;

let mermaidLoader: Promise<MermaidApi> | null = null;

export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base"
      });
      return mermaid;
    });
  }
  return mermaidLoader;
}

const EXTERNAL_LINK_PATTERN = /^https?:\/\//i;

export const markdownComponents: Components = {
  // Only a plain web link is a link. It opens in the system browser, which the
  // Main process arranges when it denies the window this target asks for.
  //
  // Everything else renders as text. An in-page anchor — a footnote marker, its
  // back-reference — would otherwise navigate the single-page shell to a route
  // it has no entry for, which drops the reader back on the home screen; and a
  // link on any other scheme has nowhere to go that is worth going.
  a({ href, children, ...props }) {
    const target = String(href ?? "");
    if (!EXTERNAL_LINK_PATTERN.test(target)) {
      // The back-reference arrow is a navigation control and nothing else, so
      // without the navigation there is nothing left of it to show.
      if ("data-footnote-backref" in props) return null;
      return <span className="markdown-inert-link">{children}</span>;
    }
    return (
      <a {...props} href={target} rel="noreferrer noopener" target="_blank">
        {children}
      </a>
    );
  },
  pre({ children, ...props }) {
    const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
      const className = String(child.props.className || "");
      const code = String(child.props.children || "").replace(/\n$/, "");
      if (MERMAID_LANGUAGE_PATTERN.test(className)) {
        return <MermaidBlock chart={code} />;
      }
      const language = CODE_LANGUAGE_PATTERN.exec(className)?.[1] || "";
      return <CodeBlock autoDetect={!language} code={code} language={language} />;
    }
    return <pre {...props}>{children}</pre>;
  },
  code({ className, children, ...props }) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  // A bare <table> in a narrow column shrinks to fit and breaks names and dates
  // mid-word. The wrapper takes the overflow so the table can stay at its
  // natural width and scroll instead.
  table({ children, ...props }) {
    return (
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    );
  }
};


export function MermaidBlock({ chart }: { chart: string }) {
  const t = useUiText();
  const reactId = useId();
  const mermaidId = useMemo(
    () => `skill-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    [reactId]
  );
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const chartText = chart.trim();

  useEffect(() => {
    let cancelled = false;

    async function renderMermaid() {
      setSvg("");
      setError("");
      if (!chartText) {
        return;
      }
      try {
        const mermaid = await loadMermaid();
        const result = await mermaid.render(mermaidId, chartText);
        if (!cancelled) {
          setSvg(result.svg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [chartText, mermaidId]);

  if (error) {
    return (
      <div className="mermaid-block error">
        <div className="mermaid-block-status error">{t.mermaid.renderError(error)}</div>
        <pre className="mermaid-source-fallback">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-block-status">{t.mermaid.rendering}</div>;
  }

  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
