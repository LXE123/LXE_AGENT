const assert = require("node:assert/strict");

module.exports = async ({ js, step, waitFor, click, state }) => {
  const toggle = '.amazon-peak-toggle input';
  const days = '.amazon-peak-days input';
  const editDays = async value => {
    await js(`(() => { const input = document.querySelector('${days}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`!document.querySelector('.vietnam-save button').disabled`, "days editable");
  };
  const loaded = () => waitFor(`Boolean(document.querySelector('${toggle}'))`, "Amazon settings loaded");
  const checked = value => waitFor(`document.querySelector('${toggle}').checked === ${value} && !document.querySelector('${toggle}').disabled`, "saved toggle");

  await step("saved-on preference still requires current-request opt-in", async () => {
    await js("behavior.mountAmazonSettings('zh')"); await loaded(); await checked(true);
    assert.match(await js("document.body.innerText"), /默认30天/);
    assert.match(await js("document.body.innerText"), /每轮默认不加成/);
    assert.equal(await js("document.querySelectorAll('[role=dialog]').length"), 0);
    assert.equal(await js(`document.querySelector('${days}').value`), "");
    assert.equal(await js("document.querySelectorAll('input[type=file]').length"), 0);
  });
  await step("off persists on remount and can be reenabled", async () => {
    await click(toggle); await checked(false);
    await js("behavior.mountAmazonSettings('en')"); await loaded(); await checked(false);
    await click(toggle); await checked(true);
    assert.deepEqual((await state()).calls.filter(call => call.operation === "amazon.save").map(call => call.input), [{ peak_boost_enabled: true, peak_boost_days: null }]);
  });
  await step("pending saves lock input and failed saves keep prior value", async () => {
    await js("behavior.amazonSaveMode('hold')"); await click(toggle);
    assert.equal(await js(`document.querySelector('${toggle}').disabled`), true);
    await js("behavior.releaseAmazonSave()"); await checked(false);
    await js("behavior.amazonSaveMode('error')"); await click(toggle); await checked(false);
    assert.match(await js("document.querySelector('[role=alert]').textContent"), /PermissionError: fixture settings denied/);
    await js("behavior.amazonSaveMode('success')");
  });
  await step("corrupt settings block the toggle and support explicit retry", async () => {
    await js("behavior.amazonReadFailure(true); behavior.mountAmazonSettings('zh')");
    await waitFor("Boolean(document.querySelector('[role=alert]'))", "actual read error");
    assert.match(await js("document.querySelector('[role=alert]').textContent"), /设置格式无效/);
    assert.equal(await js(`document.querySelector('${toggle}') === null`), true);
    await js("behavior.amazonReadFailure(false)"); await click('.workbench-refresh'); await loaded(); await checked(false);
    assert((await state()).calls.every(call => call.operation.startsWith("amazon.")));
  });
  await step("custom days persist while disabled and are used when reenabled", async () => {
    await editDays("20"); await click('.vietnam-save button');
    await waitFor("Boolean(document.querySelector('[role=status]'))", "days saved");
    await js("behavior.mountAmazonSettings('zh')"); await loaded();
    assert.equal(await js(`document.querySelector('${days}').value`), "20");
    await click(toggle); await checked(true);
    assert.deepEqual((await state()).calls.filter(call => call.operation === "amazon.save").at(-1).input, { peak_boost_enabled: true, peak_boost_days: 20 });
  });
  await step("invalid days never save and blank remains distinct from zero", async () => {
    const count = (await state()).calls.filter(call => call.operation === "amazon.save").length;
    for (const value of ["-1", "121", "1.5", "abc"]) {
      await editDays(value); await click('.vietnam-save button');
      assert.match(await js("document.querySelector('[role=alert]').textContent"), /0～120/);
    }
    assert.equal((await state()).calls.filter(call => call.operation === "amazon.save").length, count);
    for (const [value, expected] of [["0", 0], ["", null]]) {
      await editDays(value); await click('.vietnam-save button');
      await waitFor("document.querySelector('.vietnam-save button').disabled", "days persisted");
      assert.equal((await state()).calls.filter(call => call.operation === "amazon.save").at(-1).input.peak_boost_days, expected);
      await js("behavior.mountAmazonSettings('zh')"); await loaded();
      assert.equal(await js(`document.querySelector('${days}').value`), value);
    }
  });
};
