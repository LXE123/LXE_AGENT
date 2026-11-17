import React, { Fragment, memo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options, type UrlTransform } from "react-markdown";
import { advanceMarkdown, type MarkdownBlock, type MarkdownSnapshot } from "../streaming-markdown";
import { CodeBlock } from "./code-block";
import { markdownComponents, markdownRehypePlugins, markdownRemarkPlugins } from "./markdown";

const StandardPre = markdownComponents.pre ?? "pre";
// Markdown can interpret a Windows drive or a filename before ":42" as a URL scheme.
// Preserve local destinations for the conversation file-link renderer.
const chatUrlTransform: UrlTransform = (url, key, node) =>
  node.tagName === "a" && key === "href" && /^(?:file:\/\/\/|[a-z]:(?:\/|%5c)|[^/:?#]+\.[\w-]+:[1-9]\d*(?:[-:][1-9]\d*)?(?:[?#]|$))/i.test(url)
    ? url : defaultUrlTransform(url);
const previewComponents: Components = {
  ...markdownComponents,
  pre(props) {
    const child = React.Children.count(props.children) === 1 ? React.Children.only(props.children) : null;
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)
      && /\blanguage-mermaid\b/.test(child.props.className ?? "")) {
      return <CodeBlock code={String(child.props.children ?? "").replace(/\n$/, "")} language="mermaid" />;
    }
    return <StandardPre {...props} />;
  },
};

// Render the parsed node, not a standalone source slice: context can change
// the meaning of that slice. Clone before remark transforms (which may mutate
// nodes), leaving the cached grammar untouched. ReactMarkdown still applies
// its existing URL/HTML handling, math plugins and component mapping.
const MarkdownPart = memo(function MarkdownPart({ block }: { block: MarkdownBlock }) {
  if (block.pendingMath !== undefined) return <CodeBlock code={block.pendingMath} language="latex" />;
  const plugins: Options["remarkPlugins"] = block.node
    ? [() => () => ({ type: "root", children: [structuredClone(block.node!)] }), ...markdownRemarkPlugins]
    : markdownRemarkPlugins;
  return <ReactMarkdown components={block.deferDiagrams ? previewComponents : markdownComponents} urlTransform={chatUrlTransform}
    remarkPlugins={plugins} rehypePlugins={markdownRehypePlugins}>{block.node ? "" : block.text}</ReactMarkdown>;
});

export function MarkdownSnapshotView({ snapshot }: { snapshot: MarkdownSnapshot }) {
  return <div className="message-markdown">
    {[...snapshot.committed, ...snapshot.frontier].map((block, index) =>
      <Fragment key={block.start}>{index > 0 ? "\n" : null}<MarkdownPart block={block} /></Fragment>)}
  </div>;
}

export const StreamingMarkdown = memo(function StreamingMarkdown({ text, isStreaming = false }: {
  text: string; isStreaming?: boolean;
}) {
  const [previous, setPrevious] = useState(() => advanceMarkdown(undefined, text, isStreaming));
  let snapshot = previous;
  if (previous.source !== text || previous.streaming !== isStreaming) {
    snapshot = advanceMarkdown(previous, text, isStreaming);
    // Immutable render-time adjustment also handles concurrent/discarded
    // renders. Do not mutate a shared parser in a ref during React rendering.
    setPrevious(snapshot);
  }
  return <MarkdownSnapshotView snapshot={snapshot} />;
});
