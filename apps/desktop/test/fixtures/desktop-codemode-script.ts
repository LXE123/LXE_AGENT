// Runs verbatim against both the LXE harness and the Pi reference.
export const desktopCodemodeReport = `
  async function find(localName) {
    const [hit] = await searchTools(localName, { namespace: "lxe_desktop", limit: 1 });
    const declaration = await describeTool(hit.name);
    if (!declaration.includes(hit.name + "(args:") || declaration !== hit.description) throw new Error("Missing declaration");
    return hit.name;
  }
  const namespace = await describeNamespace("mcp__lxe_desktop");
  const list = await find("automation_list");
  const runs = await find("automation_runs");
  if (!namespace.tools.includes(runs) || !(await describeTool(runs)).includes("id: string")) throw new Error("Missing runs parameter");

  function data(result) {
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  const errors = [];
  for (const task of data(await tools[list]({})).items) {
    for (const run of data(await tools[runs]({ id: task.id })).items) {
      if (run.dispatch_state === "failed") errors.push(run.error);
    }
  }
  const view = await find("automation_update");
  const missing = await tools[view]({ mode: "view", id: "missing-fixture-task" });
  if (!missing.isError || !missing.content[0].text) throw new Error("Expected a tool error result");
  return errors;
`;
