const assert = require('node:assert/strict');

module.exports = async ({ js, step, settle, waitFor }) => {
  const mount = async (text, surface = 'streaming') => {
    await js(`behavior.mountMarkdown(${JSON.stringify(surface)}, ${JSON.stringify(text)})`);
    await settle();
  };
  const update = async (text, status = 'streaming', surface = 'streaming') => {
    await js(`behavior.updateMarkdown(${JSON.stringify(surface)}, ${JSON.stringify(text)}, ${JSON.stringify(status)})`);
    await settle();
  };

  await step('appending and settling preserve completed DOM, selection and horizontal table scroll', async () => {
    const prefix = 'First paragraph stays still.\n\n```js\nconst value = 1;\n```\n\n| A | B |\n|---|---|\n| ' + 'longvalue'.repeat(200) + ' | cell |\n\nThird paragraph.\n\nTail';
    await mount(prefix);
    await waitFor("document.querySelector('.code-block .hljs')", 'code highlighting finished');
    await js(`(() => {
      window.stableParagraph = document.querySelector('.message-markdown > p');
      window.stableCode = document.querySelector('.code-block');
      window.stableScroll = document.querySelector('.markdown-table-scroll');
      window.initialTop = stableParagraph.getBoundingClientRect().top;
      stableScroll.scrollLeft = 100;
      const range = document.createRange(); range.selectNodeContents(stableParagraph);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      window.oldMutations = [];
      window.oldObserver = new MutationObserver(records => oldMutations.push(...records));
      oldObserver.observe(stableParagraph, {subtree:true, childList:true, characterData:true, attributes:true});
      oldObserver.observe(stableCode, {subtree:true, childList:true, characterData:true, attributes:true});
    })()`);
    assert.equal(await js('stableScroll.scrollLeft'), 100, 'fixture table actually overflows before appending');
    let text = prefix;
    for (let i = 0; i < 15; i++) { text += ` update ${i}`; await update(text); }
    await update(text, 'completed');
    const result = await js(`(() => { oldObserver.disconnect(); return {
      paragraph: document.querySelector('.message-markdown > p') === stableParagraph,
      code: document.querySelector('.code-block') === stableCode,
      selection: getSelection().toString(), scroll: stableScroll.scrollLeft,
      table: document.querySelector('.markdown-table-scroll') === stableScroll,
      shift: stableParagraph.getBoundingClientRect().top - initialTop, mutations: oldMutations.length,
      tail: document.querySelector('.message-markdown').textContent.endsWith('update 14')
    }; })()`);
    assert.deepEqual(result, {paragraph:true, code:true, table:true, selection:'First paragraph stays still.', scroll:100, shift:0, mutations:0, tail:true});
  });

  await step('ambiguous tails are held only while streaming, including process text and error/cancel', async () => {
    for (const surface of ['streaming', 'streaming-process']) {
      for (const status of ['completed', 'error', 'cancelled']) {
        await mount('Before\n\n#', surface);
        assert.equal(await js("document.querySelectorAll('.message-markdown h1').length"), 0);
        await update('Before\n\n# Heading', 'streaming', surface);
        assert.equal(await js("document.querySelector('.message-markdown h1')?.textContent"), 'Heading');
        await update('Before\n\n$', 'streaming', surface);
        assert.equal(await js("document.querySelector('.message-markdown').textContent.includes('$')"), false);
        await update('Before\n\n$', status, surface);
        assert.equal(await js("document.querySelector('.message-markdown').textContent.includes('$')"), true);
      }
    }
  });

  await step('unfinished Mermaid stays readable as source and a completed diagram survives later chunks', async () => {
    const partial = 'Intro\n\n```mermaid\nflowchart LR\nA[';
    await mount(partial);
    assert.equal(await js("document.querySelector('.code-block')?.textContent"), 'flowchart LR\nA[');
    assert.equal(await js("document.querySelectorAll('.mermaid-block.error, .mermaid-block svg').length"), 0);
    const complete = partial + 'Start] --> B[End]\n```\n';
    await update(complete);
    await waitFor("document.querySelector('.mermaid-block svg')", 'complete Mermaid diagram');
    await js("window.stableDiagram = document.querySelector('.mermaid-block svg')");
    await update(complete + '\nNext paragraph.\n\nLast');
    assert.equal(await js("document.querySelector('.mermaid-block svg') === stableDiagram"), true);
    await update(complete + '\nNext paragraph.\n\nLast', 'completed');
    assert.equal(await js("document.querySelector('.mermaid-block svg') === stableDiagram"), true);
  });

  await step('tables and math finish with the existing Markdown output in both themes', async () => {
    for (const theme of ['light', 'dark']) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const partial = 'Intro\n\n| A | B |\n|---|---|\n| one | two |\n\n$$\n\\frac{1}{';
      await mount(partial);
      assert.equal(await js("document.querySelectorAll('.markdown-table-scroll table').length"), 1);
      assert.equal(await js("document.querySelectorAll('.katex-error').length"), 0);
      assert.equal(await js("document.querySelector('.code-block')?.textContent"), '\\frac{1}{');
      const complete = partial + '2}\n$$\n\nPrices $4.50 and $12.80.';
      await update(complete);
      assert.equal(await js("document.querySelectorAll('.katex-display').length"), 1);
      await update(complete, 'completed');
      const result = await js("document.querySelector('.message-markdown').innerHTML");
      await mount(complete, 'skill');
      assert.equal(await js("document.querySelector('.message-markdown').innerHTML"), result);
    }
  });

  await step('late references, rewrites and a fresh message do not reuse stale rendering', async () => {
    const first = '[doc]\n\nAlready complete.\n\nTail';
    await mount(first);
    assert.equal(await js("document.querySelectorAll('.message-markdown a').length"), 0);
    await update(first + '\n\n[doc]: https://example.com\n');
    assert.equal(await js("document.querySelector('.message-markdown a')?.getAttribute('href')"), 'https://example.com');
    await update('Replacement **body**.');
    assert.equal(await js("document.querySelector('.message-markdown').textContent"), 'Replacement body.');
    await update('');
    assert.equal(await js("document.querySelector('.message-markdown').textContent"), '');
    await mount('Fresh message');
    assert.equal(await js("document.querySelector('.message-markdown').textContent"), 'Fresh message');
  });
};
