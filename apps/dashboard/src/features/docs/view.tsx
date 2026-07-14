import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, CheckCircle2, ChevronRight, Copy, FileText, Search } from "lucide-react";

import { EmptyState } from "../../shared/components";
import { buildDocsTree, docsAncestorFolders, docsHrefForPath, resolveDocsMarkdownHref } from "./model";
import { useUiText } from "../../shared/i18n";
import type { Language } from "../../shared/i18n";
import type { DocsContentMode, DocsTreeNode, ProjectDocContentPayload, ProjectDocPayload } from "../../api/payloads";
import { LanguageSwitch } from "../../shared/ui/language-switch";
import { markdownComponents } from "../../shared/ui/markdown";

function docsMarkdownComponents(currentPath: string, onNavigate: (path: string) => void): Components {
  return {
    ...markdownComponents,
    a({ href, children, ...props }) {
      const docPath = resolveDocsMarkdownHref(currentPath, href);
      if (docPath) {
        return (
          <a
            {...props}
            href={docsHrefForPath(docPath)}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(docPath);
            }}
          >
            {children}
          </a>
        );
      }
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
    }
  };
}



function DocsIndex({
  docs,
  query,
  loading,
  error,
  selectedPath,
  onQueryChange,
  onOpen
}: {
  docs: ProjectDocPayload[];
  query: string;
  loading: boolean;
  error: string;
  selectedPath: string;
  onQueryChange: (value: string) => void;
  onOpen: (path: string) => void;
}) {
  const t = useUiText();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const trimmedQuery = query.trim().toLowerCase();
  const treeNodes = useMemo(() => buildDocsTree(docs), [docs]);
  const filteredDocs = useMemo(() => {
    if (!trimmedQuery) {
      return docs;
    }
    return docs.filter((doc) =>
      [doc.title, doc.path, doc.section, doc.status]
        .join(" ")
        .toLowerCase()
        .includes(trimmedQuery)
    );
  }, [docs, trimmedQuery]);
  const showSearchResults = Boolean(trimmedQuery) && filteredDocs.length > 0;
  const showTree = !trimmedQuery && treeNodes.length > 0;
  const emptyLabel = trimmedQuery ? t.docs.emptySearch : t.docs.empty;

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const ancestors = docsAncestorFolders(selectedPath);
    if (!ancestors.length) {
      return;
    }
    setExpandedFolders((current) => {
      let changed = false;
      const next = new Set(current);
      ancestors.forEach((path) => {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [selectedPath]);

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderTreeNode(node: DocsTreeNode, level: number): React.ReactNode {
    const depth = Math.min(level, 6);
    const depthStyle = { paddingLeft: `${8 + depth * 12}px` } as React.CSSProperties;
    if (node.kind === "folder") {
      const expanded = expandedFolders.has(node.path);
      return (
        <div className="docs-tree-folder" key={`folder:${node.path}`}>
          <button
            aria-expanded={expanded}
            className={expanded ? "docs-tree-folder-button expanded" : "docs-tree-folder-button"}
            onClick={() => toggleFolder(node.path)}
            style={depthStyle}
            type="button"
          >
            <ChevronRight size={14} />
            <span>{node.name}</span>
          </button>
          {expanded ? <div className="docs-tree-children">{node.children.map((child) => renderTreeNode(child, level + 1))}</div> : null}
        </div>
      );
    }
    const selected = selectedPath === node.path;
    return (
      <button
        aria-current={selected ? "page" : undefined}
        className={selected ? "docs-tree-file active" : "docs-tree-file"}
        key={`file:${node.path}`}
        onClick={() => onOpen(node.path)}
        style={depthStyle}
        title={node.path}
        type="button"
      >
        <FileText size={13} />
        <span className="docs-tree-file-copy">
          <span className="primary-cell">{node.doc.title || t.docs.untitled}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="docs-index-panel">
      <div className="search-box">
        <Search size={16} />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t.docs.searchPlaceholder}
          aria-label={t.docs.searchAria}
        />
      </div>
      {error ? <EmptyState label={t.common.errorPrefix(t.docs.errorLabel, error)} /> : null}
      {!showSearchResults && !showTree && loading && !error ? <EmptyState label={t.docs.loading} /> : null}
      {!showSearchResults && !showTree && !loading && !error ? <EmptyState label={emptyLabel} /> : null}
      {showSearchResults ? (
        <div className="docs-index-list">
          {filteredDocs.map((doc) => {
            const selected = selectedPath === doc.path;
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={selected ? "docs-index-item active" : "docs-index-item"}
                key={doc.path}
                type="button"
                onClick={() => onOpen(doc.path)}
                title={doc.path}
              >
                <span className="primary-cell">{doc.title || t.docs.untitled}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showTree ? <div className="docs-tree-list">{treeNodes.map((node) => renderTreeNode(node, 0))}</div> : null}
    </div>
  );
}

function DocsView({
  doc,
  loading,
  error,
  mode,
  copied,
  onModeChange,
  onCopy,
  onNavigateDoc
}: {
  doc: ProjectDocContentPayload | null;
  loading: boolean;
  error: string;
  mode: DocsContentMode;
  copied: boolean;
  onModeChange: (mode: DocsContentMode) => void;
  onCopy: () => void;
  onNavigateDoc: (path: string) => void;
}) {
  const t = useUiText();
  const components = useMemo(
    () => docsMarkdownComponents(doc?.path || "", onNavigateDoc),
    [doc?.path, onNavigateDoc]
  );

  if (loading && !doc) {
    return <EmptyState label={t.docs.loadingContent} />;
  }
  if (error && !doc) {
    return <EmptyState label={t.common.errorPrefix(t.docs.errorLabel, error)} />;
  }
  if (!doc) {
    return <EmptyState label={t.docs.selectPrompt} />;
  }

  return (
    <div className="docs-view">
      <div className="docs-toolbar">
        <div className="docs-actions">
          <div className="skill-content-mode-row" role="group" aria-label={t.docs.title}>
            <button
              className={mode === "preview" ? "skill-mode-button active" : "skill-mode-button"}
              onClick={() => onModeChange("preview")}
              type="button"
            >
              {t.docs.preview}
            </button>
            <button
              className={mode === "source" ? "skill-mode-button active" : "skill-mode-button"}
              onClick={() => onModeChange("source")}
              type="button"
            >
              {t.docs.source}
            </button>
          </div>
          <button className="skill-copy-button" onClick={onCopy} type="button">
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copied ? t.common.copied : t.docs.copySource}</span>
          </button>
        </div>
      </div>
      {error ? <div className="skill-content-status error">{t.common.errorPrefix(t.docs.errorLabel, error)}</div> : null}
      {loading ? <div className="skill-content-status">{t.docs.loadingContent}</div> : null}
      {mode === "preview" ? (
        <div className="docs-markdown">
          <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
            {doc.content}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="docs-content-pre">{doc.content}</pre>
      )}
    </div>
  );
}

export function DocsShell({
  docs,
  docsLoading,
  docsError,
  docQuery,
  selectedPath,
  doc,
  docLoading,
  docError,
  mode,
  copied,
  language,
  onLanguageChange,
  onDocQueryChange,
  onOpenDoc,
  onBackToDashboard,
  onModeChange,
  onCopy
}: {
  docs: ProjectDocPayload[];
  docsLoading: boolean;
  docsError: string;
  docQuery: string;
  selectedPath: string;
  doc: ProjectDocContentPayload | null;
  docLoading: boolean;
  docError: string;
  mode: DocsContentMode;
  copied: boolean;
  language: Language;
  onLanguageChange: (language: Language) => void;
  onDocQueryChange: (value: string) => void;
  onOpenDoc: (path: string) => void;
  onBackToDashboard: () => void;
  onModeChange: (mode: DocsContentMode) => void;
  onCopy: () => void;
}) {
  const t = useUiText();
  const docsContent = (() => {
    if (!selectedPath) {
      if (docsError) {
        return <EmptyState label={t.common.errorPrefix(t.docs.errorLabel, docsError)} />;
      }
      return <EmptyState label={docsLoading || docs.length ? t.docs.selectPrompt : t.docs.empty} />;
    }
    return (
      <DocsView
        doc={doc}
        loading={docLoading}
        error={docError}
        mode={mode}
        copied={copied}
        onModeChange={onModeChange}
        onCopy={onCopy}
        onNavigateDoc={onOpenDoc}
      />
    );
  })();

  return (
    <main className="docs-shell">
      <aside className="docs-shell-sidebar">
        <div className="docs-shell-sidebar-header">
          <div className="docs-shell-brand">
            <FileText size={18} />
            <span>{t.docs.title}</span>
          </div>
          <div className="docs-shell-sidebar-actions">
            <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
            <button className="docs-back-button" onClick={onBackToDashboard} type="button">
              <ArrowLeft size={15} />
              <span>{t.docs.backToDashboard}</span>
            </button>
          </div>
        </div>
        <DocsIndex
          docs={docs}
          query={docQuery}
          loading={docsLoading}
          error={docsError}
          selectedPath={selectedPath}
          onQueryChange={onDocQueryChange}
          onOpen={onOpenDoc}
        />
      </aside>
      <section className="docs-shell-main">
        <section className="docs-shell-content">{docsContent}</section>
      </section>
    </main>
  );
}
