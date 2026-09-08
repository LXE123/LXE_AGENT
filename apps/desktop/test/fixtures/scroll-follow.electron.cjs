// Start display-fixture-server.ts from the repo root, then run this with Electron.
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.on('blur', () => console.log('NATIVE WINDOW BLUR'));
  const js = code => win.webContents.executeJavaScript(code);
  const focus = async () => { app.focus({ steal: true }); win.focus(); win.webContents.focus(); await delay(200); };
  const state = () => js('scrollFollowFixture.state()');
  async function expect(following, label) {
    for (let i = 0; i < 30; i++) {
      const current = await state();
      if (current.following === following && (!following || current.distance <= 2)) return;
      await delay(100);
    }
    throw new Error(label + ': ' + JSON.stringify(await state()));
  }
  const key = async code => {
    await focus(); await js("document.querySelector('.conversation-transcript').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code });
    await delay(450);
  };
  try {
    await win.loadURL('http://127.0.0.1:5199/test/features/sessions/display-fixture.html'); await delay(800);
    await js('scrollFollowFixture.setup()'); await focus();
    const rect = await js(`(()=>{const r=document.querySelector('.conversation-transcript').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),right:Math.floor(r.right)-3,bottom:Math.floor(r.bottom)-8,top:Math.ceil(r.top)+8};})()`);
    await js(`window.followInputs=[];for(const type of ['wheel','keydown','pointerdown','pointerup','pointercancel','mouseup','touchmove'])document.querySelector('.conversation-transcript').addEventListener(type,e=>window.followInputs.push({type,trusted:e.isTrusted,top:e.currentTarget.scrollTop,pointer:e.pointerId}));`);
    const wheel = async deltaY => { win.webContents.sendInputEvent({ type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY }); await delay(350); };
    await wheel(400); await expect(false, 'wheel up');
    await wheel(-2000); await expect(true, 'wheel bottom');
    await js('scrollFollowFixture.grow()'); await expect(true, 'growth after wheel');
    console.log('PASS native wheel up/down and subsequent stream growth');
    for (const down of ['End', 'PageDown', 'Down']) {
      await key('PageUp'); await expect(false, 'PageUp');
      if (down !== 'End') await js("document.querySelector('.conversation-transcript').scrollTop=document.querySelector('.conversation-transcript').scrollHeight- document.querySelector('.conversation-transcript').clientHeight-5");
      await key(down); await expect(true, down + ' bottom');
    }
    await js('scrollFollowFixture.grow()'); await expect(true, 'growth after keyboard');
    console.log('PASS native PageUp, End, PageDown and ArrowDown');
    // Grab the current thumb center, rather than the fading overlay's end cap.
    await focus();
    const bar = await js(`(()=>{const e=document.querySelector('.conversation-transcript'),r=e.getBoundingClientRect();const thumb=Math.max(24,e.clientHeight*e.clientHeight/e.scrollHeight);return {x:Math.floor(r.right)-6,y:Math.round(r.bottom-thumb/2),bottom:Math.floor(r.bottom)+40};})()`);
    console.log('SCROLLBAR', JSON.stringify(bar));
    win.webContents.debugger.attach('1.3');
    const mouse = (type, y, buttons = 0) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: bar.x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 });
    await mouse('mouseMoved', bar.y); await delay(250);
    writeFileSync(join(tmpdir(), 'lxe-scrollbar-before.png'), (await win.webContents.capturePage()).toPNG());
    await mouse('mousePressed', bar.y, 1); await delay(100);
    for (let d=20;d<=140;d+=20) { await mouse('mouseMoved', bar.y-d, 1); await delay(30); }
    await delay(150);await expect(false, 'scrollbar held above bottom');
    if ((await state()).distance < 20) throw new Error('Native scrollbar did not actually move upward');
    await js('scrollFollowFixture.grow()'); await expect(false, 'stream grew while scrollbar held');
    for(let y=bar.y-120;y<bar.bottom;y+=20) { await mouse('mouseMoved', y, 1); await delay(30); }
    await mouse('mouseMoved', bar.bottom, 1); await delay(150);
    await expect(false, 'scrollbar held at bottom');
    if ((await state()).distance > 2) throw new Error('Native scrollbar did not actually reach bottom');
    await mouse('mouseReleased', bar.bottom);
    await expect(true, 'scrollbar released at bottom');
    await js('scrollFollowFixture.grow()'); await expect(true, 'growth after scrollbar');
    console.log('PASS native scrollbar: paused while held, follows on release');
    // Chromium's native touch input reaches the same production handlers.
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const touch = async (type, y) => { await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: rect.x, y }] }); await delay(45); };
    await touch('touchStart', rect.y - 120);
    for (let offset = 0; offset <= 240; offset += 40) await touch('touchMove', rect.y - 120 + offset);
    await touch('touchEnd'); await delay(200); await expect(false, 'touch up');
    await touch('touchStart', rect.y + 180);
    for (let offset = 0; offset <= 400; offset += 40) await touch('touchMove', rect.y + 180 - offset);
    await touch('touchEnd'); await expect(true, 'touch bottom');
    await js('scrollFollowFixture.grow()'); await expect(true, 'growth after touch');
    win.webContents.debugger.detach();
    console.log('PASS native touch up/down and subsequent stream growth');
    console.log('INPUTS', await js('JSON.stringify(followInputs)'));
    writeFileSync(join(tmpdir(), 'lxe-scroll-follow.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(0);
  } catch (error) {
    writeFileSync(join(tmpdir(), 'lxe-scrollbar-failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(error);
    console.error(await js('JSON.stringify({state:scrollFollowFixture.state(),inputs:window.followInputs})').catch(String));
    app.exit(1);
  }
});
