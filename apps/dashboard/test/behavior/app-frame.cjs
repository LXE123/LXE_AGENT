const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async ({ win, js, step, load, waitFor, click, settle, delay }) => {
  const rect = selector => js(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
  const checkFrame = async () => {
    const bounds = await rect(".app-content-frame");
    const size = await js("({width:innerWidth,height:innerHeight})");
    assert.equal(size.width - bounds.right, 4);
    assert.equal(size.height - bounds.bottom, 4);
    assert.equal(bounds.left, (await rect(".app-navigation")).right);
    assert.equal(await js("document.documentElement.scrollHeight>innerHeight || document.documentElement.scrollWidth>innerWidth"), false);
    for (const [x, y] of [[bounds.left + 1, bounds.top + 1], [bounds.right - 1, bounds.top + 1],
      [bounds.left + 1, bounds.bottom - 1], [bounds.right - 1, bounds.bottom - 1]]) {
      assert.equal(await js(`document.elementsFromPoint(${x},${y}).some(el => !el.closest('.sidebar-dismiss, .app-sidebar') && el.closest('.app-content-frame'))`), false, "rounded cutout exposes the shell");
    }
    return bounds;
  };
  const capture = async name => {
    if (!process.env.LXE_FRAME_SCREENSHOTS) return;
    mkdirSync(process.env.LXE_FRAME_SCREENSHOTS, { recursive: true });
    writeFileSync(join(process.env.LXE_FRAME_SCREENSHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  await step("appearance settings send the selected mode, including a return to system", async () => {
    await load("?app=1&workspaces=1&contracts=1&theme=system&language=en");
    await js("window.appearanceChoices = []; window.lxe.desktop.applyAppearance = async value => { window.appearanceChoices.push(value); }; void 0");
    await click(".sidebar-settings-button");
    await click(".desktop-settings-nav-item");
    await waitFor("Boolean(document.querySelector('.desktop-appearance-panel'))", "appearance settings");
    for (const [index, mode] of [[3, "dark"], [2, "light"], [1, "system"]]) {
      await click(`[aria-label="Appearance theme"] .desktop-appearance-option:nth-child(${index})`);
      assert.equal(await js("window.appearanceChoices.at(-1)"), mode);
      assert.equal(await js("localStorage.getItem('lxe.window.main.theme.v1')"), mode);
      assert.equal(await js("document.documentElement.dataset.theme"), mode === "system"
        ? await js("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'") : mode);
    }
  });
  for (const platform of ["darwin", "win32"]) {
    await step(`${platform}: every destination shares one rounded canvas in both themes`, async () => {
      await load(`?app=1&workspaces=1&contracts=1&section=sessions&platform=${platform}&language=zh`);
      assert.equal(await js("window.lxe.desktop.platform"), platform, "explicit fixture platform overrides the host");
      await waitFor("Boolean(document.querySelector('.reference-editor'))", "conversation ready");
      for (const theme of ["light", "dark"]) {
        await js(`document.documentElement.dataset.theme='${theme}'`);
        const first = await checkFrame();
        for (const page of ["home", "workbench", "automations", "capabilities", "activity", "team-skills", "sessions"]) {
          await click(".tab-" + page); await delay(220);
          assert.deepEqual(await checkFrame(), first, `${page}: outer bounds stay fixed`);
          await capture(`${platform}-${theme}-${page}`);
        }
      }
    });
    await step(`${platform}: panes, caption slots and draft survive expansion and resizing`, async () => {
      await js("window.frameDraft = document.querySelector('.reference-editor'); window.frameDraft.focus()");
      await win.webContents.insertText("保留草稿 / keep this draft");
      const first = await checkFrame();
      await js(`window.frameFilesCall = window.lxe.files.call;
        window.lxe.files.call = call => { if (call.operation === 'focus-preview') window.framePreviewFocused = call.input.focused; return window.frameFilesCall(call); }; void 0`);
      await click(".file-header-actions button");
      await waitFor("Boolean(document.querySelector('.file-sidebar'))", "tools visible");
      await settle();
      assert.equal(await js("document.querySelectorAll('.file-header-actions button, .file-panel-hide').length"), 1, "only the far-right tools toggle remains when open");
      assert.equal(await js("document.activeElement === document.querySelector('.file-panel-hide')"), true, "focus follows the visible toggle");
      assert.equal(await js("window.framePreviewFocused"), true, "opening tools also transfers native preview focus");
      await click('.file-tab [role="tab"]');
      assert.equal(await js("window.framePreviewFocused"), true, "caption tabs keep native preview focus");
      const modifier = platform === "darwin" || process.platform === "darwin" ? "metaKey" : "ctrlKey";
      assert.equal(await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'w', bubbles:true, cancelable:true, ${modifier}:true }))`), false,
        "caption shortcut is handled by its tool pane");
      await settle(); // Closing the last tool keeps the existing Start tab behavior.
      await js("window.lxe.files.call = window.frameFilesCall; void 0");
      for (const expanded of [false, true]) {
        if (expanded) await click(".file-panel-expand");
        await settle();
        assert.deepEqual(await checkFrame(), first);
        const pane = await rect(".file-sidebar"), strip = await rect(".file-tab-strip");
        assert.equal(await js("document.querySelectorAll('.file-header-actions button, .file-panel-hide').length"), 1, "split and full-width tools each have one toggle");
        assert.ok(Math.abs(pane.right - first.right + 1) < 0.02);
        assert.ok(Math.abs(strip.right - pane.right) < 0.02, "tool caption aligns with its pane");
        assert.ok(Math.abs(pane.bottom - first.bottom + 1) < 0.02);
        assert.equal(await js("document.querySelector('.reference-editor') === window.frameDraft"), true);
        assert.match(await js("window.frameDraft.textContent"), /保留草稿/);
        await capture(`${platform}-tools-${expanded ? "full" : "split"}`);
      }
      await click(".file-panel-hide");
      assert.equal(await js("document.querySelector('.app-caption-tools')?.children.length ?? 0"), 0, "closing tools releases its caption slot");
      assert.equal(await js("document.querySelectorAll('.file-header-actions button, .file-panel-hide').length"), 1, "closing tools restores the conversation toggle");
      assert.equal(await js("document.activeElement === document.querySelector('.file-header-actions button')"), true, "focus returns to the conversation toggle");
      await click(".sidebar-toggle-button"); await delay(220);
      assert.deepEqual(await checkFrame(), first);
      win.setContentSize(800, 700); await delay(250);
      await checkFrame();
      await click(".file-header-actions button"); await settle();
      const strip = await rect(".file-tab-strip"), toggle = await rect(".sidebar-toggle-button");
      if (platform === "darwin") {
        const firstTab = await rect(".file-tab");
        assert.ok(firstTab.left >= toggle.right, "narrow tools avoid the sidebar toggle");
        assert.equal(strip.top, 0);
      }
      await capture(`${platform}-narrow-tools`);
      await click(".file-panel-hide");
      assert.equal(await js("document.querySelector('.reference-editor') === window.frameDraft"), true);
      win.setContentSize(1200, 900); await delay(250);
    });
  }
};
