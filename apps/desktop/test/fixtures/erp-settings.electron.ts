// Opt-in native smoke. Bundle the dashboard ERP fixture and this runner with Bun;
// run Electron <runner.cjs> <fixture.html>. Uses only mocked setup data and IPC.
import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1100, height: 850 });
  const errors: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const js = (source: string) => window.webContents.executeJavaScript(source);
  const waitFor = (condition: string) => js(`new Promise((resolve,reject)=>{
    let tries=0;const timer=setInterval(()=>{
      if(${condition}){clearInterval(timer);resolve(true)}
      else if(++tries>250){clearInterval(timer);reject(new Error('Timed out: '+document.body.innerText))}
    },20)
  })`);
  const tab = async (index: number) => {
    await js(`document.querySelectorAll('[role=tab]')[${index}].click()`);
    await waitFor(`document.querySelectorAll('[role=tab]')[${index}].getAttribute('aria-selected')==='true'`);
  };
  const edit = async (index: number, value: string) => {
    await js(`(()=>{const input=document.querySelectorAll('[role=tabpanel] input')[${index}];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  };
  const inputs = () => js("[...document.querySelectorAll('[role=tabpanel] input')].map(input=>input.value)");
  const paint = () => js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  try {
    await window.loadFile(resolve(process.argv[2]!));
    await waitFor("document.querySelector('#open-settings')");
    await js("document.querySelector('#open-settings').click()");
    await waitFor("document.querySelectorAll('[role=tab]').length===4");
    assert.deepEqual(await js("[...document.querySelectorAll('[role=tab]')].map(e=>e.textContent)"), ["马帮 TMS", "雅仓", "上马", "马帮"]);
    assert.equal(await js("document.querySelector('[role=tab][aria-selected=true]').textContent"), "马帮 TMS");
    assert.equal(await js("[...document.querySelectorAll('.desktop-settings-nav-item')].filter(e=>e.textContent.includes('ERP')).length"), 1);
    assert((await js("document.querySelector('.desktop-settings-nav-item.active').textContent")).includes("3/4"));
    assert.deepEqual(await inputs(), ["mock-tms", ""]);
    await edit(0, "edited-tms");
    await tab(1); await edit(1, "draft-yacang-password");
    await tab(2); await edit(0, "edited-id");
    assert.equal((await inputs()).length, 3);
    await tab(0); assert.deepEqual(await inputs(), ["edited-tms", ""]);
    assert.equal(await js("document.querySelectorAll('.desktop-erp-tabs .desktop-settings-dirty-dot').length"), 3);
    assert.equal(await js("Boolean(document.querySelector('.desktop-settings-nav-item.active .desktop-settings-dirty-dot'))"), true);
    assert.equal(await js("window.erpFixture.calls.length"), 0);

    await js("window.erpFixture.failSave=true;document.querySelector('button[type=submit]').click()");
    await waitFor("document.querySelector('.desktop-form-error')");
    assert.equal(await js("document.querySelector('.desktop-form-error').textContent"), "Mock ERP storage failure: EACCES");
    await tab(1); assert.deepEqual(await inputs(), ["mock-mobile", "draft-yacang-password"]);
    await js("window.erpFixture.failSave=false;document.querySelector('button[type=submit]').click()");
    await waitFor("!document.querySelector('.desktop-settings-modal')");
    const saved = await js("window.erpFixture.calls.at(-1)");
    assert.equal(saved.mabangTms.account, "edited-tms");
    assert.equal(saved.mabangTms.password, undefined);
    assert.equal(saved.yacang.password, "draft-yacang-password");
    assert.equal(saved.shangman.tenant_id, "edited-id");
    await js("document.querySelector('#open-settings').click()");
    await waitFor("document.querySelector('[role=tabpanel]')");
    assert.equal(await js("document.querySelector('[role=tab][aria-selected=true]').textContent"), "雅仓");
    assert.deepEqual(await inputs(), ["mock-mobile", ""]);
    await edit(1, "keep-this-draft");
    await tab(0);
    await js("document.querySelector('.desktop-clear-integration').click()");
    await waitFor("document.querySelector('.desktop-confirm-dialog')");
    assert.equal(await js("window.erpFixture.calls.length"), 2);
    await js("document.querySelector('.desktop-confirm-dialog .desktop-danger-button').click()");
    await waitFor("!document.querySelector('.desktop-confirm-dialog') && !document.querySelector('.desktop-clear-integration')");
    assert.deepEqual(await inputs(), ["", ""]);
    assert.deepEqual(await js("Object.keys(window.erpFixture.calls.at(-1)).sort()"), ["logging", "mabangTms", "workspace_root"]);
    await tab(1); assert.deepEqual(await inputs(), ["mock-mobile", "keep-this-draft"]);
    for (const [key, index] of [["ArrowRight", 2], ["End", 3], ["ArrowRight", 0], ["ArrowLeft", 3], ["Home", 0]] as const) {
      await js(`document.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true}))`);
      await waitFor(`document.querySelectorAll('[role=tab]')[${index}].getAttribute('aria-selected')==='true'`);
      assert.equal(await js(`document.activeElement===document.querySelectorAll('[role=tab]')[${index}]`), true);
    }
    await tab(2);
    for (const width of [1100, 600]) {
      window.setSize(width, 850);
      await waitFor(`innerWidth===${width}`);
      for (const language of ["zh", "en"]) for (const theme of ["light", "dark"]) {
        await js(`window.fixtureLanguage('${language}');document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.fontSize='large'`);
        await waitFor(`document.querySelector('[role=tab]').textContent==='${language === "zh" ? "马帮 TMS" : "Mabang TMS"}'`);
        assert.equal(await js(`(()=>{const content=document.querySelector('.desktop-settings-content');
          return content.scrollWidth<=content.clientWidth && document.documentElement.scrollWidth<=innerWidth
          && [...document.querySelectorAll('[role=tabpanel] input')].every(e=>e.getBoundingClientRect().width>100);})()`), true);
        await js("document.querySelectorAll('[role=tab]')[3].scrollIntoView({block:'nearest',inline:'nearest'})");
        assert.equal(await js(`(()=>{const tabs=document.querySelector('[role=tablist]'),last=tabs.lastElementChild;
          return last.getBoundingClientRect().right<=tabs.getBoundingClientRect().right+1;})()`), true);
        await paint();
        writeFileSync(`/tmp/lxe-erp-${width}-${language}-${theme}.png`, (await window.webContents.capturePage()).toPNG());
      }
    }
    await window.loadFile(resolve(process.argv[2]!), { query: { onboarding: "1" } });
    await waitFor("document.querySelector('.desktop-onboarding-card')");
    await js("[...document.querySelectorAll('.desktop-settings-nav-item')].find(e=>e.textContent.includes('ERP')).click()");
    await waitFor("document.querySelectorAll('[role=tab]').length===4");
    await edit(0, "onboarding-tms"); await tab(2); await edit(0, "onboarding-id");
    await tab(0); assert.deepEqual(await inputs(), ["onboarding-tms", ""]);
    await js("document.querySelector('.desktop-clear-integration').click()");
    await waitFor("document.querySelector('.desktop-confirm-dialog')");
    await js("document.querySelector('.desktop-confirm-dialog .desktop-danger-button').click()");
    await waitFor("!document.querySelector('.desktop-confirm-dialog') && !document.querySelector('.desktop-clear-integration')");
    await tab(2); assert.equal((await inputs())[0], "onboarding-id");
    await paint();
    writeFileSync("/tmp/lxe-erp-onboarding.png", (await window.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log("PASS ERP settings: drafts, save failure/retry, blank passwords, targeted clear, keyboard, session selection, onboarding, 8 layout variants");
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    app.exit(1);
  }
});
