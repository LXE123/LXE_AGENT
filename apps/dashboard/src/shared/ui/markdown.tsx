import React, { useEffect, useId, useMemo, useState } from "react";
import rehypeKatex from "rehype-katex";
import type { Components, Options } from "react-markdown";

import "katex/dist/katex.min.css";
import { useUiText } from "../i18n";
import { CodeBlock } from "./code-block";

export { markdownRemarkPlugins } from "../markdown-plugins";

export const markdownRehypePlugins: NonNullable<Options["rehypePlugins"]> = [rehypeKatex];

const MERMAID_LANGUAGE_PATTERN = /\blanguage-mermaid\b/;
const CODE_LANGUAGE_PATTERN = /\blanguage-([^\s]+)\b/;

type MermaidApi = typeof import("mermaid").default;

let mermaidLoader: Promise<MermaidApi> | null = null;
let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((module) => module.default);
  }
  return mermaidLoader;
}

function renderMermaidChart(id: string, chart: string) {
  // initialize changes Mermaid's global configuration. Keep it and the entire
  // async render together so several diagrams cannot overwrite each other's theme.
  const render = mermaidRenderQueue.then(async () => {
    const mermaid = await loadMermaid();
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const color = (token: string) => styles.getPropertyValue(token).trim();
    const text = color("--text");
    const border = color("--border-strong");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        darkMode: root.dataset.theme === "dark",
        background: color("--surface"),
        primaryColor: color("--conversation-muted-fill"),
        secondaryColor: color("--surface-subtle"),
        tertiaryColor: color("--surface"),
        primaryTextColor: text,
        secondaryTextColor: text,
        tertiaryTextColor: text,
        primaryBorderColor: border,
        secondaryBorderColor: border,
        tertiaryBorderColor: border,
        lineColor: color("--muted"),
        arrowheadColor: color("--muted"),
        edgeLabelBackground: color("--surface"),
        noteBkgColor: color("--surface-subtle"),
        noteTextColor: text,
        noteBorderColor: border,
        fontFamily: color("--font-sans"),
        fontSize: styles.fontSize,
      },
    });
    return mermaid.render(id, chart);
  });
  // A malformed diagram must not prevent subsequent diagrams from rendering.
  mermaidRenderQueue = render.catch(() => {});
  return render;
}

const EXTERNAL_LINK_PATTERN = /^https?:\/\//i;

export const markdownComponents = {
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
} satisfies Components;


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
    let revision = 0;

    async function renderMermaid() {
      const currentRevision = ++revision;
      setSvg("");
      setError("");
      if (!chartText) {
        return;
      }
      try {
        const result = await renderMermaidChart(mermaidId, chartText);
        if (!cancelled && currentRevision === revision) {
          setSvg(result.svg);
        }
      } catch (err) {
        if (!cancelled && currentRevision === revision) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    const observer = new MutationObserver(() => { void renderMermaid(); });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-font-size"],
    });
    void renderMermaid();
    return () => {
      cancelled = true;
      observer.disconnect();
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
