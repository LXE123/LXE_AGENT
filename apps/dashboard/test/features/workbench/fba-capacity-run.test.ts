import { describe, expect, test } from "bun:test";
import {
  FBA_CAPACITY_SITES, capacityPrompt, conversationDeleted, forgetRun, loadFullAccess, loadRuns, loadSelection, outputFolder, recordRun, resultFiles, runState, saveFullAccess, saveSelection,
  type FbaCapacityRun,
} from "../../../src/features/workbench/fba-capacity-run";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const run = (id: string): FbaCapacityRun => ({
  id, created_at: 1, stores: ["Amazon-YYH-US"], sites: ["US"], session_id: `s-${id}`, turn_id: id, output: `FBA库容报告/${id}`,
});

describe("FBA capacity run", () => {
  test("prompt invokes the skill with stores and sites in page order", () => {
    const prompt = capacityPrompt({ stores: ["Amazon-HSP-US", "Amazon-XIUTAI-US"], sites: ["DE", "US"] }, "FBA库容报告/20261118-203015");
    expect(prompt.startsWith("/amazon-fba-capacity-report\n")).toBe(true);
    expect(prompt.indexOf("- Amazon-XIUTAI-US")).toBeLessThan(prompt.indexOf("- Amazon-HSP-US"));
    expect(prompt).toContain("站点：US DE");
    expect(prompt).toContain("`FBA库容报告/20261118-203015`");
    expect(prompt).not.toContain("report.html");
    expect(prompt).toContain("严格大于 90%");
  });

  test("all eight sites read as the skill default, and empty choices are rejected", () => {
    expect(capacityPrompt({ stores: ["Amazon-YYH-US"], sites: [...FBA_CAPACITY_SITES] }, "out")).toContain("站点：默认八站");
    expect(() => capacityPrompt({ stores: [], sites: ["US"] }, "out")).toThrow("至少选择一个店铺");
    expect(() => capacityPrompt({ stores: ["Amazon-YYH-US"], sites: [] }, "out")).toThrow("至少选择一个站点");
    expect(() => capacityPrompt({ stores: ["Amazon-Unknown-US"], sites: ["US"] }, "out")).toThrow("至少选择一个店铺");
  });

  test("output folder is named by local start time", () => {
    expect(outputFolder(new Date(2026, 10, 8, 9, 5, 7))).toBe("FBA库容报告/20261108-090507");
  });

  test("a running turn that waits on the user shows as waiting", () => {
    expect(runState("running", { question: true, approval: false })).toBe("waiting_input");
    expect(runState("running", { question: false, approval: true })).toBe("waiting_approval");
    expect(runState("running", { question: false, approval: false })).toBe("running");
    expect(runState("completed", { question: true, approval: true })).toBe("completed");
  });

  test("results list the workbooks, skipping Excel lock files, folders and other files", () => {
    expect(resultFiles([
      { name: "shots", path: "out/shots", kind: "directory" },
      { name: "Report.HTML", path: "out/Report.HTML", kind: "file" },
      { name: "A-库容截图-20261118.xlsx", path: "out/A-库容截图-20261118.xlsx", kind: "file" },
      { name: "~$A-库容截图-20261118.xlsx", path: "out/~$A-库容截图-20261118.xlsx", kind: "file" },
    ])).toEqual([{ name: "A-库容截图-20261118.xlsx", path: "out/A-库容截图-20261118.xlsx" }]);
    expect(resultFiles([])).toEqual([]);
  });

  test("history keeps the newest ten runs and ignores damaged entries", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 12; index++) recordRun(run(String(index)), storage);
    const runs = loadRuns(storage);
    expect(runs.map(item => item.id)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"]);
    expect(loadRuns(memoryStorage({ "lxe.workbench.fba-capacity.runs.v1": "[{\"id\":1},null]" }))).toEqual([]);
    expect(loadRuns(memoryStorage({ "lxe.workbench.fba-capacity.runs.v1": "not json" }))).toEqual([]);
    expect(loadRuns(null)).toEqual([]);
  });

  test("removing a run from the history keeps the others in order", () => {
    const storage = memoryStorage();
    for (const id of ["a", "b", "c"]) recordRun(run(id), storage);
    expect(forgetRun("b", storage).map(item => item.id)).toEqual(["c", "a"]);
    expect(loadRuns(storage).map(item => item.id)).toEqual(["c", "a"]);
    expect(forgetRun("missing", storage).map(item => item.id)).toEqual(["c", "a"]);
  });

  test("only the runtime's missing-session message counts as a deleted conversation", () => {
    expect(conversationDeleted(new Error("Error invoking remote method 'lxe:dashboard-call': DashboardRpcError: session not found"))).toBe(true);
    expect(conversationDeleted(new Error("Agent runtime is unavailable"))).toBe(false);
    expect(conversationDeleted(new Error("Session workspace not found"))).toBe(false);
  });

  test("selection defaults to no stores and all sites, then remembers the last choice", () => {
    const storage = memoryStorage();
    expect(loadSelection(storage)).toEqual({ stores: [], sites: [...FBA_CAPACITY_SITES] });
    saveSelection({ stores: ["Amazon-YRZ-US", "Gone-Store"], sites: ["JP", "US"] }, storage);
    expect(loadSelection(storage)).toEqual({ stores: ["Amazon-YRZ-US"], sites: ["US", "JP"] });
  });

  test("Full access is off until confirmed and is kept on runs that used it", () => {
    const storage = memoryStorage();
    expect(loadFullAccess(storage)).toBe(false);
    expect(loadFullAccess(memoryStorage({ "lxe.workbench.fba-capacity.full-access.v1": "\"true\"" }))).toBe(false);
    saveFullAccess(true, storage);
    expect(loadFullAccess(storage)).toBe(true);
    saveFullAccess(false, storage);
    expect(loadFullAccess(storage)).toBe(false);
    recordRun({ ...run("a"), full_access: true }, storage);
    recordRun(run("b"), storage);
    expect(loadRuns(storage).map(item => item.full_access ?? false)).toEqual([false, true]);
  });
});
