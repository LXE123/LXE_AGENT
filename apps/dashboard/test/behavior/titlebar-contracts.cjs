const assert = require("node:assert/strict");
module.exports = async ({suite,win,js,step,load,waitFor,click,key,focus,settle,delay}) => {
      const rect = selector => js(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; })()`);
      const menu = '.windows-titlebar-menu [role="menuitem"]';
      await load("?app=1&workspaces=1&section=sessions&platform=win32");
      await waitFor("Boolean(document.querySelector('.windows-titlebar-menu'))", "caption mounted");
      win.webContents.focus(); await settle();
      const captionBottom = async () => (await rect('.windows-titlebar-menu')).bottom;
  if(suite === "windows-menu") {
      await step("caption menus preserve input selection for pointer and keyboard activation", async () => {
        await load("?app=1&workspaces=1&section=sessions&platform=win32");
        await js(`window.lxe.desktop.showTitlebarMenu=async request=>{ window.captionRequest=request; window.captionFocus=document.activeElement.className; window.captionSelection=getSelection().toString(); return null; };undefined`);
        await waitFor("Boolean(document.querySelector('.reference-editor'))", "composer mounted");
        await waitFor("document.querySelector('.reference-editor')?.getAttribute('contenteditable')==='true'", 'composer enabled');
        await focus('.reference-editor'); await win.webContents.insertText('Keep selected draft'); await settle();
        await focus('.reference-editor');
        // Select through Chromium so Lexical and the DOM agree on the saved selection.
        await key('a', [process.platform === 'darwin' ? 'meta' : 'control']);
        await js(`document.querySelectorAll('${menu}')[1].dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));document.querySelectorAll('${menu}')[1].click()`); await settle();
        assert.match(await js('captionFocus'),/reference-editor/);
        assert.equal(await js('captionSelection'),'Keep selected draft');
        await focus(menu); await key('Right'); await key('Down');
        assert.match(await js('captionFocus'),/reference-editor/);
        assert.equal(await js('captionRequest.menu'),'edit');
        assert.equal(await js('captionSelection'),'Keep selected draft');
      });
      await step("application actions reuse settings and updater without installing or repeating checks", async () => {
        await js(`window.captionAction='settings';window.captionChecks=0;window.captionInstalls=0;window.lxe.desktop.showTitlebarMenu=async()=>captionAction;window.lxe.desktop.getUpdateState=async()=>({phase:'idle'});window.lxe.desktop.checkForUpdate=async()=>{captionChecks++;return {phase:'idle',message:'Already current'};};window.lxe.desktop.installUpdate=async()=>{captionInstalls++;return {phase:'ready'};};undefined`);
        await click(menu);
        await waitFor("Boolean(document.querySelector('.desktop-settings-modal'))", "settings via menu");
        assert.equal((await rect('.desktop-settings-backdrop')).top,await captionBottom());
        assert.equal(await js('captionChecks'),0);
        await js("window.captionAction='check-updates'"); await click(menu);
        await waitFor('captionChecks===1', 'single manual update check');
        await waitFor("document.querySelector('.lxe-update-manual')?.textContent.includes('No updates available')", "update feedback");
        assert.equal(await js('captionInstalls'),0);
        await key('Escape'); await js("window.captionAction='settings'"); await click(menu); await delay(150);
        assert.equal(await js('captionChecks'),1);
        await key('Escape');
      });
  } else {
      await step("all Windows columns begin below one caption in either theme and sidebar state", async () => {
        for (const theme of ["light", "dark"]) {
          await load("?app=1&workspaces=1&section=sessions&platform=win32");
          await waitFor("Boolean(document.querySelector('.windows-titlebar-menu'))", "fresh caption mounted");
          await js(`document.documentElement.dataset.theme='${theme}'`);
          for (let i=0;i<2;i++) {
            assert.equal((await rect('.app-navigation')).top, await captionBottom());
            assert.equal((await rect('.main-panel')).top, await captionBottom());
            const toggle = await rect('.sidebar-toggle-button');
            assert.ok(toggle.top>=0 && toggle.bottom<=await captionBottom());
            assert.ok((await rect(menu)).left>=toggle.right, 'caption controls do not overlap');
            assert.equal(await js("getComputedStyle(document.querySelector('.windows-titlebar-menu')).webkitAppRegion"), "no-drag");
            assert.equal(await js("document.documentElement.scrollHeight>innerHeight"), false);
            assert.equal(
              await js("getComputedStyle(document.querySelector('.desktop-platform-win32'), '::before').backgroundColor"),
              await js("getComputedStyle(document.querySelector('.main-panel')).backgroundColor"),
              'caption follows the content theme in either sidebar state',
            );
            if (i === 1) {
              // Use a real pointer: DOM clicks alone do not exercise :hover or delayed peek.
              await js("document.activeElement.blur()");
              win.webContents.sendInputEvent({ type: 'mouseMove', x: 800, y: 400 });
              await delay(220);
              win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(toggle.left+toggle.width/2), y: Math.round(toggle.top+toggle.height/2) });
              await settle();
              await waitFor("document.querySelector('.app-sidebar').classList.contains('is-peek')", 'caption hover peek');
              await delay(180);
              const contrast = await js(`(() => {
                const button = document.querySelector('.sidebar-toggle-button');
                const rgb = value => value.match(/[\\d.]+/g).map(Number);
                const ink = rgb(getComputedStyle(button.querySelector('svg')).stroke);
                const fill = rgb(getComputedStyle(button).backgroundColor);
                const caption = rgb(getComputedStyle(document.querySelector('.desktop-platform-win32'), '::before').backgroundColor);
                const alpha = fill[3] ?? 1;
                const luminance = color => color.slice(0, 3).map(v => v / 255)
                  .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
                  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
                const a = luminance(ink), b = luminance(fill.map((v, i) => v * alpha + caption[i] * (1 - alpha)));
                return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
              })()`);
              if (process.env.LXE_TITLEBAR_SCREENSHOT) {
                require('node:fs').writeFileSync(process.env.LXE_TITLEBAR_SCREENSHOT.replace(/\.png$/, '-hover-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
              }
              assert.ok(contrast >= 3, `${theme} caption icon must remain visible while peeking (contrast ${contrast})`);
            }
            await click('.sidebar-toggle-button'); await delay(220);
          }
        }
        for (const tab of ['home','workbench','capabilities','activity','sessions']) {
          const exists = await js(`Boolean(document.querySelector('.tab-${tab}'))`);
          if (exists) { await click(`.tab-${tab}`); assert.equal((await rect('.main-panel')).top,await captionBottom()); }
        }
        await click('.tab-sessions');
      });
      await step("Chinese menus and full preview stay below caption", async () => {
        await load("?app=1&workspaces=1&section=sessions&platform=win32&language=zh");
        await waitFor("Boolean(document.querySelector('.windows-titlebar-menu'))", "Chinese caption");
        assert.deepEqual(await js(`Array.from(document.querySelectorAll('${menu}')).map(e=>e.textContent)`),['应用','编辑']);
        const preview = '.file-header-actions button';
        await click(preview);
        await waitFor("Boolean(document.querySelector('.file-sidebar'))", "preview opened");
        assert.equal((await rect('.file-sidebar')).top,await captionBottom());
        await click('.file-tab-strip > button:nth-last-child(2)');
        assert.equal((await rect('.file-sidebar')).top,await captionBottom());
        if(process.env.LXE_TITLEBAR_SCREENSHOT) {
          for(const theme of ['dark','light']) {
            await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
            require('node:fs').writeFileSync(process.env.LXE_TITLEBAR_SCREENSHOT.replace(/\.png$/, '-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
          }
        }
      });
  }
};
