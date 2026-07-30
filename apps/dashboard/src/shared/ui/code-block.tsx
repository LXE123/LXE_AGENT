import React, { useEffect, useState } from "react";

type HighlightApi = typeof import("highlight.js/lib/core").default;

/**
 * Only the languages that actually reach the transcript: tool payloads (shell,
 * json, yaml, diff) plus the file types this repo is written in. Registering
 * the full highlight.js bundle would multiply the download for grammars no
 * conversation here will ever contain.
 */
const LANGUAGE_MODULES: Record<string, () => Promise<{ default: unknown }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  ini: () => import("highlight.js/lib/languages/ini"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: "bash", sh: "bash", zsh: "bash", fish: "bash",
  css: "css",
  diff: "diff", patch: "diff",
  cfg: "ini", conf: "ini", ini: "ini", toml: "ini",
  cjs: "javascript", js: "javascript", jsx: "javascript", mjs: "javascript",
  json: "json", jsonl: "json",
  markdown: "markdown", md: "markdown",
  py: "python", pyi: "python",
  sql: "sql",
  cts: "typescript", mts: "typescript", ts: "typescript", tsx: "typescript",
  htm: "xml", html: "xml", svg: "xml", xml: "xml",
  yaml: "yaml", yml: "yaml",
};

/** Maps a filename or path onto a registered language, or "" when unknown. */
export function languageForPath(path: string): string {
  const name = path.trim().replace(/\\/g, "/").split("/").at(-1) || "";
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() || "" : "";
  return EXTENSION_LANGUAGES[extension] || "";
}

let highlighterLoader: Promise<HighlightApi> | null = null;

function loadHighlighter(): Promise<HighlightApi> {
  if (!highlighterLoader) {
    highlighterLoader = (async () => {
      const core = (await import("highlight.js/lib/core")).default;
      const entries = Object.entries(LANGUAGE_MODULES);
      const modules = await Promise.all(entries.map(([, load]) => load()));
      entries.forEach(([name], index) => {
        core.registerLanguage(name, modules[index].default as never);
      });
      return core;
    })();
  }
  return highlighterLoader;
}

/**
 * Renders code as code. Until the highlighter has loaded — and whenever the
 * language is one we do not register — the plain text still shows, so a
 * highlighting failure can never hide a tool's actual output.
 */
export function CodeBlock({
  code,
  language = "",
  className = "",
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const supported = Boolean(language && LANGUAGE_MODULES[language]);
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (!supported || !code) {
      setHtml("");
      return;
    }
    let cancelled = false;
    loadHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        setHtml(highlighter.highlight(code, { language, ignoreIllegals: true }).value);
      })
      .catch(() => {
        if (!cancelled) setHtml("");
      });
    return () => {
      cancelled = true;
    };
  }, [code, language, supported]);

  const classes = ["code-block", language ? `language-${language}` : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <pre className={classes}>
      {html
        ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        : <code>{code}</code>}
    </pre>
  );
}
