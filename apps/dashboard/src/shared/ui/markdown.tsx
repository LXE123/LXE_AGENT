import React, { useEffect, useId, useMemo, useState } from "react";
import type { Components } from "react-markdown";

import { useUiText } from "../i18n";

const MERMAID_LANGUAGE_PATTERN = /\blanguage-mermaid\b/;

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

export const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const isExternal = Boolean(href && /^(https?:)?\/\//i.test(href));
    return (
      <a
        {...props}
        href={href}
        rel={isExternal ? "noreferrer noopener" : undefined}
        target={isExternal ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  pre({ children, ...props }) {
    const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
      const className = String(child.props.className || "");
      if (MERMAID_LANGUAGE_PATTERN.test(className)) {
        return <MermaidBlock chart={String(child.props.children || "").replace(/\n$/, "")} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
  code({ className, children, ...props }) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
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
