import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { advanceMarkdown, parseMarkdown, type MarkdownSnapshot } from "../../src/shared/streaming-markdown";
import { MarkdownSnapshotView } from "../../src/shared/ui/streaming-markdown";
import { markdownComponents, markdownRemarkPlugins, markdownRehypePlugins } from "../../src/shared/ui/markdown";

const ordinary = (text: string) => renderToStaticMarkup(<div className="message-markdown">
  <ReactMarkdown components={markdownComponents} remarkPlugins={markdownRemarkPlugins}
    rehypePlugins={markdownRehypePlugins}>{text}</ReactMarkdown>
</div>);
const render = (snapshot: MarkdownSnapshot) => renderToStaticMarkup(<MarkdownSnapshotView snapshot={snapshot} />);

const samples = {
  prose: "# 标题 🐉\n\n第一段 **加粗** 和 *强调*。\n\n第二段 [链接](https://example.com) 和 `code`。\n\n尾段。",
  lists: "1. first\n\n2. second\n\n   continued\n\n   - nested\n   - [x] done\n\n3. third\n\nAfter.\n",
  quote: "Before\n\n> First\n>\n> Second\n>\n>> Nested\n\nAfter\n",
  table: "Intro\n\n| 名称 | 数量 |\n| :--- | ---: |\n| A | 12 |\n| B | 23 |\n\nAfter\n",
  setext: "Intro\n\nTitle\n-----\n\nParagraph\n\n***\n\nLast\n",
  code: "Intro\n\n````ts\nconst a = 1;\n\n```\n# not a heading\n````\n\nAfter\n",
  indented: "Intro\n\n    one\n\n    two\n\nAfter\n",
  math: "Prices $4.50 and $12.80.\n\n$$\nx^2 + y^2\n$$\n\nInline $$a+b$$ here.\n\n$$ x^2 $$\n\nAfter\n",
  reference: "A [later][id].\n\nMiddle\n\n[id]: https://example.com \"Title\"\n\nAgain [id].\n",
  footnote: "First[^b], second[^a].\n\n[^a]: Note A\n\n[^b]: Note B\n\nFirst[^b] again.\n",
  nestedDefinition: "[outside][id]\n\n> [id]: https://example.com\n\nAfter\n",
  html: "Before\n\n<div>\nraw HTML\n\nAfter\n\n<script>alert('x')</script>\n\n[unsafe](javascript:alert(1))\n",
  breaks: "  Leading\r\n\r\n## Header\r\n\r\nHard break  \r\nnext\r\n\r\nEnd",
  unfinished: "Intro\n\n```ts\nconst a = 1\n\n# literal\n",
  lazyList: "- First\n  lazy continuation\n\n  > quote\n  >\n  > continued\n\n- Second\n\nAfter\n",
  nestedFence: "Before\n\n- List\n\n  ```js\n  # code\n  ```\n\n  continuation\n\nAfter\n",
  referenceContinuation: "[link]\n\n[link]:\n  https://example.com\n  \"multi-line title\"\n\nAfter\n",
  tabs: "Before\n\n\tindented\n\tmore\n\n- item\n\t- child\n\nAfter\n",
  codeExit: "Before\n\n    code\n\n-\nNext\n\nAfter\n\nFinal\n",
  quotedCodeExit: "> quoted\n>\n    code\n2. item\nTail",
  quotedCodeSplit: ">\n    a\n\n    b\nTail",
};

describe("incremental conversation Markdown", () => {
  for (const [name, source] of Object.entries(samples)) {
    test(`${name}: every chunk boundary settles to the ordinary Markdown output`, () => {
      let state: MarkdownSnapshot | undefined;
      for (let i = 1; i <= source.length; i++) {
        const text = source.slice(0, i);
        state = advanceMarkdown(state, text, true);
        // Compare each possible interrupted/failed/stopped stream, not just a
        // well-formed complete example. Finalization must not hide any tail.
        expect(render(advanceMarkdown(state, text, false))).toBe(ordinary(text));
        // During streaming, all ordinary complete blocks have the same grammar.
        // Marker holding, incomplete formula/diagram previews are intentional.
        if (!state.held && !state.frontier.some(part => part.pendingMath !== undefined || part.deferDiagrams)) {
          expect(render(state)).toBe(ordinary(text));
        }
      }
      expect(render(advanceMarkdown(state, source, false))).toBe(ordinary(source));
    });
  }

  test("committed objects and keys survive append and ordinary settlement", () => {
    let state = advanceMarkdown(undefined, "First paragraph.\n\nSecond paragraph.\n\nThird", true);
    expect(state.committed).toHaveLength(1);
    const first = state.committed[0];
    state = advanceMarkdown(state, state.source + " paragraph.\n\nFourth", true);
    expect(state.committed[0]).toBe(first);
    const second = state.committed[1];
    const final = advanceMarkdown(state, state.source, false);
    expect(final.committed[0]).toBe(first);
    expect(final.committed[1]).toBe(second);
    expect(advanceMarkdown(final, final.source, false)).toBe(final);
  });

  test("opening historical text needs no incremental boundary parse", () => {
    const parse = () => { throw new Error("static content should use the existing renderer directly"); };
    const state = advanceMarkdown(undefined, samples.footnote, false, parse);
    expect(render(state)).toBe(ordinary(samples.footnote));
  });

  test("unfinished list markers cannot freeze a preceding list", () => {
    let state = advanceMarkdown(undefined, "1. One\n\n2", true);
    expect(state.committed).toHaveLength(0);
    state = advanceMarkdown(state, state.source + ". Two\n\nAfter\n", true);
    expect(render(state)).toBe(ordinary(state.source));
    expect(render(state).match(/<ol>/g)).toHaveLength(1);
  });

  test("ambiguous markers and partial closing fences are held, then restored or consumed", () => {
    let state = advanceMarkdown(undefined, "Text\n\n#", true);
    expect(state.held).toBe("#");
    expect(render(state)).not.toContain("#");
    expect(render(advanceMarkdown(state, state.source, false))).toBe(ordinary(state.source));
    state = advanceMarkdown(state, state.source + " Heading\n", true);
    expect(render(state)).toContain("<h1>Heading</h1>");
    state = advanceMarkdown(undefined, "```js\nconst x = 1\n``", true);
    expect(state.held).toBe("``");
    expect(render(state)).not.toContain("``");
    state = advanceMarkdown(state, state.source + "x", true);
    expect(state.held).toBe("");
    expect(render(state)).toContain("``x");
    state = advanceMarkdown(undefined, "Before\n\n```mer", true);
    expect(state.held).toBe("```mer");
    expect(render(state)).not.toContain("<pre");
  });

  test("late references resolve earlier text and share footnote numbering", () => {
    let state = advanceMarkdown(undefined, "Read [doc].\n\nSecond\n\nThird", true);
    expect(state.committed.length).toBeGreaterThan(0);
    state = advanceMarkdown(state, state.source + "\n\n[doc]: https://example.com\n", true);
    expect(state.documentContext).toBe(true);
    expect(render(state)).toBe(ordinary(state.source));
    expect(render(state)).toContain('href="https://example.com"');
    const parse = () => { throw new Error("document fallback needs no second boundary parse"); };
    state = advanceMarkdown(state, state.source + "\n#", true, parse);
    expect(state.held).toBe("");
    expect(state.frontier[0]?.deferDiagrams).toBe(false);
    expect(render(state)).toBe(ordinary(state.source));
  });

  test("rewrite, truncation and resumed output invalidate only the disposable cache", () => {
    let state = advanceMarkdown(undefined, samples.prose, true);
    for (const text of ["Replacement\n\nBody", "Replacement", "", samples.lists]) {
      state = advanceMarkdown(state, text, true);
      expect(render(advanceMarkdown(state, text, false))).toBe(ordinary(text));
    }
    state = advanceMarkdown(state, state.source, false);
    const resumed = advanceMarkdown(state, state.source + "\nResumed", true);
    expect(render(resumed)).toBe(ordinary(resumed.source));
  });

  test("a growing long reply does not repeatedly parse its completed prefix", () => {
    let state: MarkdownSnapshot | undefined;
    let parsed = 0, full = 0;
    const parse = (text: string) => { parsed += text.length; return parseMarkdown(text); };
    const source = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ${"ordinary words ".repeat(8)}\n\n`).join("");
    for (let i = 20; i < source.length; i += 20) {
      full += i;
      state = advanceMarkdown(state, source.slice(0, i), true, parse);
    }
    state = advanceMarkdown(state, source, false, parse);
    expect(state.committed).toHaveLength(80);
    expect(parsed).toBeLessThan(full / 10);
    expect(render(state)).toBe(ordinary(source));
  });

  test("mixed block boundaries retain the same grammar as the full document", () => {
    const fragments = ["paragraph\n", "\n", "# heading\n", "---\n", "-\n", "- item\n", "2. item\n",
      "    code\n", "\tcode\n", "> quote\n", "```js\nx\n```\n", "| A | B |\n|---|---|\n| x | y |\n", "<div>\nraw\n</div>\n"];
    const semantic = (nodes: unknown) => JSON.stringify(nodes, (key, value) => key === "position" ? undefined : value);
    let seed = 71;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let scenario = 0; scenario < 160; scenario++) {
      const source = Array.from({ length: 7 }, () => fragments[random() % fragments.length]).join("");
      let state: MarkdownSnapshot | undefined;
      for (let end = 1; end <= source.length; end += 1 + random() % 9) {
        state = advanceMarkdown(state, source.slice(0, end), true);
        if (state.held || state.documentContext) continue;
        const nodes = [...state.committed, ...state.frontier].map(part => part.node);
        expect(semantic(nodes), JSON.stringify(state.source)).toBe(semantic(parseMarkdown(state.source).children));
      }
    }
  });
});
