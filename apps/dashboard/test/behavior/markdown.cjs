const assert = require("node:assert/strict");

module.exports = async ({ win, js, step, settle }) => {
  const mount = async (surface, content) => {
    await js(`behavior.mountMarkdown(${JSON.stringify(surface)}, ${JSON.stringify(content)})`);
    await js("document.fonts.ready.then(() => undefined)");
    await settle();
    assert.equal(await js("document.querySelectorAll('.message-markdown').length"), 1);
  };
  for (const surface of ["conversation", "skill"]) {
    await step(`${surface}: all six heading levels render with a readable hierarchy`, async () => {
      const content = Array.from({ length: 6 }, (_, i) => `${"#".repeat(i + 1)} Heading ${i + 1}\n\nBody ${i + 1}.`).join("\n\n");
      await mount(surface, content);
      const headings = await js(`Array.from(document.querySelectorAll('.message-markdown :is(h1,h2,h3,h4,h5,h6)')).map(el => ({
        tag: el.tagName, text: el.textContent, body: el.nextElementSibling.textContent,
        size: parseFloat(getComputedStyle(el).fontSize), bodySize: parseFloat(getComputedStyle(el.nextElementSibling).fontSize),
        height: el.getBoundingClientRect().height, bottom: el.getBoundingClientRect().bottom,
        bodyTop: el.nextElementSibling.getBoundingClientRect().top,
      }))`);
      assert.deepEqual(headings.map(h => [h.tag, h.text, h.body]),
        Array.from({ length: 6 }, (_, i) => [`H${i + 1}`, `Heading ${i + 1}`, `Body ${i + 1}.`]));
      for (const [index, heading] of headings.entries()) {
        assert.ok(heading.height > 0, `${heading.tag} is rendered`);
        assert.ok(heading.size >= heading.bodySize, `${heading.tag} is not smaller than its body: ${JSON.stringify(heading)}`);
        if (index) assert.ok(heading.size <= headings[index - 1].size, "heading sizes follow their semantic hierarchy");
        assert.ok(heading.bodyTop >= heading.bottom - 1, "heading does not overlap the following paragraph");
      }
      assert.ok(headings[0].size > headings[0].bodySize, "H1 remains visually distinct from body text");
    });

    await step(`${surface}: quotes preserve paragraphs, emphasis and nested quotation`, async () => {
      await mount(surface, "Before the quote.\n\n> First **important** paragraph.\n>\n> Second paragraph.\n>\n>> Nested quotation.\n\nAfter the quote.");
      const quote = await js(`(() => {
        const root = document.querySelector('.message-markdown');
        const el = root.querySelector('blockquote');
        return { paragraphs: Array.from(el.querySelectorAll(':scope > p')).map(p => p.textContent),
          emphasis: el.querySelector('strong')?.textContent, nested: el.querySelector(':scope > blockquote > p')?.textContent,
          before: el.previousElementSibling.textContent, after: el.nextElementSibling.textContent,
          top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom,
          beforeBottom: el.previousElementSibling.getBoundingClientRect().bottom,
          afterTop: el.nextElementSibling.getBoundingClientRect().top };
      })()`);
      assert.deepEqual(quote.paragraphs, ["First important paragraph.", "Second paragraph."]);
      assert.equal(quote.emphasis, "important");
      assert.equal(quote.nested, "Nested quotation.");
      assert.equal(quote.before, "Before the quote.");
      assert.equal(quote.after, "After the quote.");
      assert.ok(quote.bottom > quote.top, "quote is rendered");
      assert.ok(quote.top >= quote.beforeBottom - 1 && quote.afterTop >= quote.bottom - 1,
        `quote does not overlap adjacent paragraphs: ${JSON.stringify(quote)}`);
    });

    await step(`${surface}: long headings and quotes wrap within the available width`, async () => {
      const heading = "LongHeading".repeat(36);
      const paragraph = "长引用内容".repeat(30) + "UnbrokenQuotedWord".repeat(35);
      // Desktop default and minimum content viewports; no exact aesthetic spacing.
      for (const [width, height] of [[1280, 820], [960, 640]]) {
        win.setContentSize(width, height);
        await mount(surface, `## ${heading}\n\n> ${paragraph}`);
        const layout = await js(`(() => {
          const root = document.querySelector('.message-markdown');
          const bounds = root.getBoundingClientRect();
          return { viewport: innerWidth, left: bounds.left, right: bounds.right,
            width: root.clientWidth, scrollWidth: root.scrollWidth,
            pageWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth,
            blocks: Array.from(root.querySelectorAll('h2, blockquote p')).map(el => {
              const range = document.createRange(); range.selectNodeContents(el);
              return { text: el.textContent, height: el.getBoundingClientRect().height,
                lineHeight: parseFloat(getComputedStyle(el).lineHeight),
                rects: Array.from(range.getClientRects()).map(r => ({ left: r.left, right: r.right })) };
            }) };
        })()`);
        const context = `${surface} at ${width}x${height}: ${JSON.stringify(layout)}`;
        assert.equal(layout.viewport, width, "requested viewport was applied");
        assert.deepEqual(layout.blocks.map(block => block.text), [heading, paragraph], "long text is preserved in full");
        assert.ok(layout.width > 0 && layout.left >= -1 && layout.right <= layout.viewport + 1, context);
        assert.ok(layout.scrollWidth <= layout.width + 1, context);
        assert.ok(layout.pageScrollWidth <= layout.pageWidth + 1, context);
        for (const block of layout.blocks) {
          assert.ok(block.height > block.lineHeight * 1.5 && block.rects.length > 1, "long text wraps onto multiple lines");
          // Text ranges catch clipping too: overflow:hidden alone must not pass.
          assert.ok(block.rects.every(rect => rect.left >= layout.left - 1 && rect.right <= layout.right + 1), context);
        }
      }
    });
  }
};
