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
const conversation = { sessionId: "s", directory: "/Users/me/project", open() {} };

describe("conversation markdown links", () => {
  test("workspace links render in streaming and completed conversations with a preview handler", () => {
    const markdown = "[查看完整分析](./reports/分析%20%231.md) [Notes](notes.md)";
    for (const isStreaming of [true, false]) {
      const view = <StreamingMarkdown text={markdown} isStreaming={isStreaming} />;
      expect(renderToStaticMarkup(view)).not.toContain('role="link"');
      const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={conversation}>{view}</OpenMarkdownFileContext.Provider>);
      expect(markup).toContain('title="reports/分析 #1.md">查看完整分析</button>');
      expect(markup).toContain('title="notes.md">Notes</button>');
    }
  });

  test("keeps escaped Markdown, anchors, foreign drives and network file URLs inert", () => {
    const urls = ["#section", "C:/other.md", "//example.org/file", "file://server/share", "file:////server/share", "mailto:user@example.org", "%2e%2e/other.md", "%2Fexternal", "foo%5Cbar", "bad%00.md"];
    const markdown = ["[报告]\\(./report.md)", ...urls.map(href => `[label](${href})`)].join(" ");
    const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={conversation}><StreamingMarkdown text={markdown} /></OpenMarkdownFileContext.Provider>);
    expect(markup).not.toContain('role="link"');
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("[报告](./report.md)");
  });

  test("explicit absolute links and line targets work in GFM table cells and paragraphs", () => {
    const cells = "[打开 README.md](/Users/me/project/README.md) | [起点](/Users/me/project/scripts/source.ts:42) · [终点](/Users/me/project/scripts/source.ts:50)";
    for (const isStreaming of [true, false]) {
      const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={conversation}>
        <StreamingMarkdown isStreaming={isStreaming} text={`| 文件 | 位置 |\n| --- | --- |\n| ${cells} |\n\n${cells} \`scripts/source.ts:42\`\n\n[同名前缀](/Users/me/project-old/README.md) [穿越](/Users/me/project/%2e%2e/elsewhere/file.md)`} />
      </OpenMarkdownFileContext.Provider>);
      expect(markup).toContain("<tbody>");
      for (const title of ["README.md", "scripts/source.ts:42", "scripts/source.ts:50"]) {
        expect(markup.split(`title="${title}"`).length - 1).toBe(2);
      }
      expect(markup.match(/role="link"/g)).toHaveLength(7);
      expect(markup).toContain('data-linked-path="/Users/me/project-old/README.md"');
      expect(markup).toMatch(/<code[^>]*>scripts\/source\.ts:42<\/code>/);
    }
  });

  test("Windows drive links can cross workspaces and root-level relative links can carry lines", () => {
    const text = "[a](c:/PROJECT/src/app.ts:42) [b](C:%5CProject%5Cdir%5Cb.ts#L50) [c](README.md:9) [outside](D:/Project/file.ts) [sibling](C:/Project2/file.ts) [share](//remote/Project/file.ts)";
    const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={{ ...conversation, directory: "C:\\Project" }}>
      <StreamingMarkdown text={text} />
    </OpenMarkdownFileContext.Provider>);
    expect(markup.match(/role="link"/g)).toHaveLength(5);
    expect(markup).toContain('data-linked-path="D:/Project/file.ts"');
    for (const title of ["src/app.ts:42", "dir/b.ts:50", "README.md:9"]) expect(markup).toContain(`title="${title}"`);
  });

  test("explicit local links retain their filename, line or range across workspace boundaries", () => {
    const text = "[报告](file:///tmp/项目%20%231.md) [父目录](../src/app.ts:42:7) [主目录](~/app.ts#L50-L42) [区间](/tmp/test.ts:42-50)";
    const markup = renderToStaticMarkup(<OpenMarkdownFileContext.Provider value={conversation}><StreamingMarkdown text={text} /></OpenMarkdownFileContext.Provider>);
    expect(markup.match(/data-linked-session="s"/g)).toHaveLength(4);
    for (const title of ["/tmp/项目 #1.md", "../src/app.ts:42", "~/app.ts:42-50", "/tmp/test.ts:42-50"]) expect(markup).toContain(`title="${title}"`);
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
