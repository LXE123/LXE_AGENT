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
    await title("Default chat(1)");
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
    await title("Default chat(2)");
    assert.deepEqual((await forkCalls()).at(-1).input, { session_id: "Default chat" });
  });
  await step("branch disclosure works with keyboard, preserves selection, and uses CDS guides in both themes", async () => {
    const toggle = '[data-session-id="Default chat"] .session-branch-toggle';
    await waitFor("document.querySelectorAll('.session-branch-children .session-index-item').length === 2", "both children");
    await click(toggle);
    assert.equal(await js("document.querySelector('.session-branch-children').hidden"), true);
    await title("Default chat(2)");
    await key("Enter");
    assert.equal(await js("document.querySelector('.session-branch-children').hidden"), false);
    await click('[data-session-id="Branch 1"] .session-index-open');
    await title("Default chat(1)");
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
    await title("Default chat(3)");
    await waitFor("document.querySelector('.session-branch-children .session-branch-children [data-session-id=\"Branch 3\"]')", "nested child");
    await click('[data-session-id="Default chat"] .session-branch-toggle');
    await click(header);
    await click(action);
    await title("Default chat(4)");
    await waitFor("document.querySelector('[data-session-id=\"Branch 4\"]')?.getClientRects().length > 0", "new nested branch visible");
    assert.equal(await js("document.querySelector('[data-session-id=\"Default chat\"] .session-branch-toggle').getAttribute('aria-expanded')"), "true");
  });
  await step("search finds branches as standalone rows and normal browsing restores the hierarchy", async () => {
    await click('.sidebar-search-button');
    await click('.search-box input');
    await win.webContents.insertText('Default chat(');
    await waitFor("document.querySelectorAll('.session-index-open').length === 4", "matching branches");
    assert.equal(await js("document.querySelectorAll('.session-branch-children').length"), 0);
    await click('[data-session-id="Branch 4"] .session-index-open');
    await title('Default chat(4)');
    await click('.session-search-close');
    await waitFor("document.querySelector('.session-branch-children .session-branch-children [data-session-id=\"Branch 4\"]')?.getClientRects().length > 0", "restored family");
  });
  await step("clicking the empty area after a parent disclosure opens the chat without collapsing it", async () => {
    const point = await js(`(() => {
      const row = document.querySelector('[data-session-id="Default chat"]');
      const toggle = row.querySelector('.session-branch-toggle').getBoundingClientRect();
      const menu = row.querySelector('.session-index-actions').getBoundingClientRect();
      const x = Math.round((toggle.right + menu.left) / 2), y = Math.round(toggle.top + toggle.height / 2);
      return { x, y, gap: menu.left - toggle.right, target: document.elementFromPoint(x, y)?.className };
    })()`);
    assert.ok(point.gap > 8, "exercise the empty area, not the title button");
    assert.match(point.target, /session-index-item/);
    for (const type of ["mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x: point.x, y: point.y });
    await title("Default chat");
    assert.equal(await js("document.querySelector('[data-session-id=\"Default chat\"] .session-branch-toggle').getAttribute('aria-expanded')"), "true");
  });
  const menuAction = pattern => js(`Array.from(document.querySelectorAll('.session-actions-menu [role="menuitem"]')).find(b => ${pattern}.test(b.textContent)).click()`);
  await step("pinning a middle branch keeps the remaining family joined, and unpinning restores its direct parent", async () => {
    const depth = id => js(`document.querySelector('[data-session-id="${id}"]').style.getPropertyValue('--session-branch-depth')`);
    assert.equal(await depth("Branch 3"), "2");
    await click('[data-session-id="Branch 1"] .session-index-actions');
    await menuAction('/^(Pin|置顶)$/');
    await waitFor("document.querySelector('[data-session-id=\"Branch 3\"]').style.getPropertyValue('--session-branch-depth') === '1'", "promoted child");
    assert.equal(await depth("Branch 1"), "0");
    assert.equal(await depth("Branch 4"), "2");
    assert.equal(await js("document.querySelectorAll('[data-session-id=\"Branch 1\"]').length"), 1);
    assert.equal((await state()).sessions.find(row => row.session_id === "Branch 3").source.fork.session_id, "Branch 1");
    if (process.env.LXE_FORK_SCREENSHOTS) {
      await settle();
      const rect = await js("(() => { const b = document.querySelector('.workspace-group').getBoundingClientRect(); return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()");
      require('node:fs').writeFileSync(require('node:path').join(process.env.LXE_FORK_SCREENSHOTS, 'fork-pinned-middle.png'), (await win.webContents.capturePage(rect)).toPNG());
    }
    await click('[data-session-id="Branch 1"] .session-index-actions');
    await menuAction('/^(Unpin|取消置顶)$/');
    await waitFor("document.querySelector('[data-session-id=\"Branch 3\"]').style.getPropertyValue('--session-branch-depth') === '2'", "restored direct parent");
  });
  await step("the sidebar menu forks its own target, even when another conversation is selected", async () => {
    await title("Default chat");
    await click('[data-session-id="Branch 2"] .session-index-actions');
    await menuAction('/^(Create branch|创建分支)$/');
    await title("Default chat(5)");
    assert.deepEqual((await forkCalls()).at(-1).input, { session_id: "Branch 2" });
    await waitFor("document.querySelector('[id=\"session-branches-Branch 2\"] [data-session-id=\"Branch 5\"]')", "menu branch parent");
  });
  await step("running work disables the header and sidebar fork while completed history remains available", async () => {
    await js("behavior.busySession('Branch 5')");
    await waitFor("document.querySelector(" + JSON.stringify(header) + ")?.disabled", "busy header");
    assert.equal(await js("document.querySelector(" + JSON.stringify(footer) + ")?.disabled"), false);
    await click('[data-session-id="Branch 5"] .session-index-actions');
    assert.equal(await js("Array.from(document.querySelectorAll('.session-actions-menu [role=menuitem]')).find(b=>/Create branch|创建分支/.test(b.textContent))?.disabled"), true);
  });
};
