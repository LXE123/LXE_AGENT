const assert = require("node:assert/strict");

module.exports = async ({ js, step, waitFor, click, state }) => {
  const days = '.amazon-peak-days input', toggle = '.amazon-peak-toggle input';
  const save = '.workbench-settings-actions button';
  const loaded = () => waitFor(`Boolean(document.querySelector('${days}'))`, "settings loaded");
  const edit = async value => {
    await js(`(() => { const input = document.querySelector('${days}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`!document.querySelector('${save}').disabled`, "settings editable");
  };
  await step("page loads disabled without days and enabling requires a value", async () => {
    await js("behavior.mountAmazonV2Settings('zh')"); await loaded();
    assert.equal(await js(`document.querySelector('${toggle}').checked`), false);
    assert.equal(await js(`document.querySelector('${days}').value`), "");
    await click(toggle); await click(save);
    assert.match(await js("document.querySelector('[role=alert]').textContent"), /请填写加成天数/);
    assert.equal((await state()).calls.filter(call => call.operation === "amazon-v2.save").length, 0);
  });
  await step("settings save and reload through the Desktop bridge", async () => {
    await edit("20"); await click(save);
    await waitFor(`document.querySelector('${save}').disabled && !document.querySelector('${days}').disabled`, "saved");
    assert.deepEqual((await state()).calls.filter(call => call.operation === "amazon-v2.save").at(-1).input,
      { peak_boost_enabled: true, peak_boost_days: 20 });
    await js("behavior.mountAmazonV2Settings('zh')"); await loaded();
    assert.equal(await js(`document.querySelector('${days}').value`), "20");
    assert.equal(await js(`document.querySelector('${toggle}').checked`), true);
  });
  await step("failed saves show the actual error and preserve the draft", async () => {
    await edit("40"); await js("behavior.amazonSaveMode('error')"); await click(save);
    await waitFor("Boolean(document.querySelector('[role=alert]'))", "save error");
    assert.match(await js("document.querySelector('[role=alert]').textContent"), /PermissionError: fixture settings denied/);
    assert.equal(await js(`document.querySelector('${days}').value`), "40");
    await js("behavior.amazonSaveMode('success'); behavior.mountAmazonV2Settings('zh')"); await loaded();
    assert.equal(await js(`document.querySelector('${days}').value`), "20");
  });
  await step("failed settings reads show the actual error and retry successfully", async () => {
    await js("behavior.amazonReadMode('error'); behavior.mountAmazonV2Settings('zh')");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('settings read denied')", "settings read error");
    assert.match(await js("document.querySelector('[role=alert]').textContent"), /PermissionError: fixture settings read denied/);
    await js("behavior.amazonReadMode('success')");
    await click(".workbench-refresh");
    await loaded();
    assert.equal(await js(`document.querySelector('${days}').value`), "20");
    assert.equal(await js("document.querySelector('[role=alert]')"), null);
  });
};
