const assert = require("node:assert/strict");

module.exports = async ({ win, js, step, load, waitFor, click, key, settle, state }) => {
  await load("?app=1&workspaces=1&section=sessions&forkFixture=1");
  const parent = '.workspace-group[data-workspace-directory="/fixture/default"] .session-index-open';
  const footer = '.answer-footer button[aria-haspopup="menu"]';
  const header = '.conversation-header-actions button[popovertarget]';
  const action = '.conversation-fork-menu:popover-open [role="menuitem"]';
  const title = name => waitFor("document.querySelector('.conversation-header h2')?.textContent === " + JSON.stringify(name), name);
  const forkCalls = async () => (await state()).calls.filter(call => call.operation === "sessions.fork");
  await waitFor("Boolean(document.querySelector(" + JSON.stringify(parent) + "))", "parent session");
  await click(parent);
  await title("Default chat");
  await step("each completed turn has one branch action and opens an independent chat at its cutoff", async () => {
    await waitFor("document.querySelectorAll(" + JSON.stringify(footer) + ").length === 2", "two turn footers");
    await click(footer);
    const bounds = await js(`(() => {
      const more = document.querySelector('${footer}');
      const row = more.closest('.answer-footer');
      const rect = el => el.getBoundingClientRect().toJSON();
      return { copy: rect(row.querySelector('.message-meta-copy')), more: rect(more),
        time: rect(row.querySelector('time')), menu: rect(row.querySelector(':popover-open')) };
    })()`);
    assert.ok(bounds.more.left >= bounds.copy.right && bounds.more.left - bounds.copy.right <= 8, "more sits beside copy");
    assert.ok(bounds.time.left >= bounds.more.right && bounds.time.left - bounds.more.right <= 10, "time follows both actions");
    assert.ok(Math.abs(bounds.more.left - bounds.menu.left) <= 1 && bounds.more.top - bounds.menu.bottom >= 0
      && bounds.more.top - bounds.menu.bottom <= 8, "reply menu opens just above its trigger");
    await click(action);
    await title("Branch 1");
    assert.deepEqual((await forkCalls()).at(-1).input, { session_id: "Default chat", turn_id: "one" });
    assert.equal(await js("document.querySelector('.reference-editor').textContent"), "");
    assert.equal(await js("document.querySelector('.conversation-body').innerText.includes('assistant two')"), false);
  });
  await step("branches appear beneath their parent without a source-navigation action", async () => {
    await waitFor("document.querySelector('.session-branch-children [data-session-id=\"Branch 1\"]')", "branch hierarchy");
    assert.equal(await js("Array.from(document.querySelectorAll('.conversation-header button')).some(b=>/查看分叉来源|View branch source/.test(b.title))"), false);
    await click('[data-session-id="Default chat"] .session-index-open');
    await title("Default chat");
    assert.equal((await state()).calls.some(call => call.operation === "sessions.detail" && call.input.message_turn_id), false);
    await waitFor("document.querySelector(" + JSON.stringify(header) + ")?.disabled === false", "available header branch");
    assert.equal(await js(`(() => { const style = getComputedStyle(document.querySelector('${header}'));
      return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px'; })()`), true,
      "the idle titlebar action has no surrounding box");
    await click(header);
    await waitFor("Boolean(document.querySelector(" + JSON.stringify(action) + "))", "header menu open");
    assert.ok(await js(`(() => { const b = document.querySelector('${header}').getBoundingClientRect();
      const m = document.querySelector('.conversation-fork-menu:popover-open').getBoundingClientRect();
      return m.top >= b.bottom && m.top - b.bottom <= 8 && Math.abs(b.right - m.right) <= 1; })()`),
      "titlebar menu opens below and stays aligned to the trigger");
    await click(action);
    await title("Branch 2");
    assert.deepEqual((await forkCalls()).at(-1).input, { session_id: "Default chat" });
  });
  await step("branch disclosure works with keyboard, preserves selection, and uses CDS guides in both themes", async () => {
    const toggle = '[data-session-id="Default chat"] .session-branch-toggle';
    await waitFor("document.querySelectorAll('.session-branch-children .session-index-item').length === 2", "both children");
    await click(toggle);
    assert.equal(await js("document.querySelector('.session-branch-children').hidden"), true);
    await title("Branch 2");
    await key("Enter");
    assert.equal(await js("document.querySelector('.session-branch-children').hidden"), false);
    await click('[data-session-id="Branch 1"] .session-index-open');
    await title("Branch 1");
    for (const theme of ["light", "dark"]) {
      await js(`document.documentElement.dataset.theme = '${theme}'`);
      await settle();
      await js("Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))");
      await settle();
      const layout = await js(`(() => {
        const parent = document.querySelector('[data-session-id="Default chat"]');
        const child = document.querySelector('[data-session-id="Branch 1"]');
        const last = document.querySelector('[data-session-id="Branch 2"]');
        const title = row => row.querySelector('.primary-cell').getBoundingClientRect();
        return { indent: title(child).left - title(parent).left,
          sameWidth: child.clientWidth === parent.clientWidth,
          selected: child.classList.contains('active'),
          elbow: getComputedStyle(last.querySelector('.session-branch-guide')).borderBottomLeftRadius,
          color: getComputedStyle(child.querySelector('.session-branch-guide')).borderLeftColor,
          overflow: child.scrollWidth > child.clientWidth };
      })()`);
      assert.equal(layout.indent, 20);
      assert.equal(layout.sameWidth, true);
      assert.equal(layout.selected, true);
      assert.equal(layout.elbow, "8px");
      assert.notEqual(layout.color, "rgba(0, 0, 0, 0)");
      assert.equal(layout.overflow, false);
      if (process.env.LXE_FORK_SCREENSHOTS) {
        const fs = require('node:fs'), path = require('node:path');
        fs.mkdirSync(process.env.LXE_FORK_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(path.join(process.env.LXE_FORK_SCREENSHOTS, `fork-${theme}.png`), (await win.webContents.capturePage()).toPNG());
        const rect = await js("(() => { const box = document.querySelector('.workspace-group').getBoundingClientRect(); return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) }; })()");
        fs.writeFileSync(path.join(process.env.LXE_FORK_SCREENSHOTS, `fork-sidebar-${theme}.png`), (await win.webContents.capturePage(rect)).toPNG());
      }
    }
  });
  await step("forking a branch creates another level, and opening it expands its ancestors", async () => {
    await click(header);
    await click(action);
    await title("Branch 3");
    await waitFor("document.querySelector('.session-branch-children .session-branch-children [data-session-id=\"Branch 3\"]')", "nested child");
    await click('[data-session-id="Default chat"] .session-branch-toggle');
    await click(header);
    await click(action);
    await title("Branch 4");
    await waitFor("document.querySelector('[data-session-id=\"Branch 4\"]')?.getClientRects().length > 0", "new nested branch visible");
    assert.equal(await js("document.querySelector('[data-session-id=\"Default chat\"] .session-branch-toggle').getAttribute('aria-expanded')"), "true");
  });
  await step("search finds branches as standalone rows and normal browsing restores the hierarchy", async () => {
    await click('.sidebar-search-button');
    await click('.search-box input');
    await win.webContents.insertText('Branch');
    await waitFor("document.querySelectorAll('.session-index-open').length === 4", "matching branches");
    assert.equal(await js("document.querySelectorAll('.session-branch-children').length"), 0);
    await click('[data-session-id="Branch 4"] .session-index-open');
    await title('Branch 4');
    await click('.session-search-close');
    await waitFor("document.querySelector('.session-branch-children .session-branch-children [data-session-id=\"Branch 4\"]')?.getClientRects().length > 0", "restored family");
  });
  await step("running work disables the header while completed history remains available", async () => {
    await js("behavior.busySession('Branch 4')");
    await waitFor("document.querySelector(" + JSON.stringify(header) + ")?.disabled", "busy header");
    assert.equal(await js("document.querySelector(" + JSON.stringify(footer) + ")?.disabled"), false);
  });
};
