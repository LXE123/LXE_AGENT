import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownComponents, OpenMarkdownFileContext } from "../../src/shared/ui/markdown";
import { StreamingMarkdown } from "../../src/shared/ui/streaming-markdown";

const render = (markdown: string): string => renderToStaticMarkup(
  <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
    {markdown}
  </ReactMarkdown>,
);

describe("conversation markdown links", () => {
  test("workspace links render in streaming and completed conversations with a preview handler", () => {
    const markdown = "[查看完整分析](./reports/分析%20%231.md) [Notes](notes.md)";
    for (const isStreaming of [true, false]) {
      const view = <StreamingMarkdown text={markdown} isStreaming={isStreaming} />;
      expect(renderToStaticMarkup(view)).not.toContain('role="link"');
      const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={() => {}}>{view}</OpenMarkdownFileContext.Provider>);
      expect(markup).toContain('title="reports/分析 #1.md">查看完整分析</button>');
      expect(markup).toContain('title="notes.md">Notes</button>');
    }
  });

  test("keeps escaped Markdown, anchors and non-workspace targets inert", () => {
    const urls = ["#section", "../other.md", "/tmp/other.md", "C:/other.md", "//example.org/file", "file:///file", "mailto:user@example.org", "%2e%2e/other.md", "%2Fexternal", "foo%5Cbar", "bad%00.md"];
    const markdown = ["[报告]\\(./report.md)", ...urls.map(href => `[label](${href})`)].join(" ");
    const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={() => {}}><StreamingMarkdown text={markdown} /></OpenMarkdownFileContext.Provider>);
    expect(markup).not.toContain('role="link"');
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("[报告](./report.md)");
  });

  test("sends a web link to the system browser and keeps the opener isolated", () => {
    const markup = render("[百度](https://www.baidu.com) 和 <http://example.com>");

    expect(markup).toContain('href="https://www.baidu.com"');
    expect(markup).toContain('href="http://example.com"');
    expect((markup.match(/target="_blank"/g) ?? []).length).toBe(2);
    expect((markup.match(/rel="noreferrer noopener"/g) ?? []).length).toBe(2);
  });

  test("renders a link on any other scheme as plain text", () => {
    const markup = render("[邮件](mailto:someone@example.com) [文件](file:///etc/passwd)");

    expect(markup).not.toContain("<a");
    expect(markup).not.toContain("mailto:");
    expect(markup).not.toContain("file:///");
    expect(markup).toContain("邮件");
    expect(markup).toContain("文件");
  });

  // An in-page anchor navigates the shell to a route it cannot resolve, which
  // drops the reader on the home screen and loses the conversation.
  test("leaves nothing clickable in a footnote", () => {
    const markup = render("带脚注的话[^1]\n\n[^1]: 脚注内容");

    expect(markup).toContain("脚注内容");
    expect(markup).not.toContain("<a");
    expect(markup).not.toContain('href="#');
    expect(markup).not.toContain("footnote-backref");
  });
});
