const assert = require("node:assert/strict");

module.exports = async ({ js, step, load, waitFor, click, state }) => {
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
    await click(action);
    await title("Branch 1");
    assert.deepEqual((await forkCalls()).at(-1).input, { session_id: "Default chat", turn_id: "one" });
    assert.equal(await js("document.querySelector('.reference-editor').textContent"), "");
    assert.equal(await js("document.querySelector('.conversation-body').innerText.includes('assistant two')"), false);
  });
  await step("the origin link opens the parent at the selected turn and the header forks the latest turn", async () => {
    await js("Array.from(document.querySelectorAll('.conversation-header button')).find(b=>/查看分叉来源|View branch source/.test(b.title)).click()");
    await title("Default chat");
    assert.ok((await state()).calls.some(call => call.operation === "sessions.detail" && call.input.message_turn_id === "one"));
    await waitFor("document.querySelector(" + JSON.stringify(header) + ")?.disabled === false", "available header branch");
    await click(header);
    await waitFor("Boolean(document.querySelector(" + JSON.stringify(action) + "))", "header menu open");
    await click(action);
    await title("Branch 2");
    assert.deepEqual((await forkCalls()).at(-1).input, { session_id: "Default chat" });
  });
  await step("running work disables the header while completed history remains available", async () => {
    await js("behavior.busySession('Branch 2')");
    await waitFor("document.querySelector(" + JSON.stringify(header) + ")?.disabled", "busy header");
    assert.equal(await js("document.querySelector(" + JSON.stringify(footer) + ")?.disabled"), false);
  });
};
