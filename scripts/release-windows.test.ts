import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow, type WorkflowPorts } from "./release-windows";
import { sha512, writeJsonAtomic, type ReleaseCandidate } from "./release-candidate";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lxe release fixture "));
  mkdirSync(join(root, "config"));
  const release = { schema_version: 1, version: "0.2.19", notes: "测试发布：中文说明\n第二行" };
  writeFileSync(join(root, "config", "desktop-release.json"), JSON.stringify(release));
  const directory = join(root, "dist", "desktop-candidates"), current = join(directory, "current.json");
  const calls: string[][] = [], logs: string[] = [];
  const githubReleases: ReleaseCandidate[] = [];
  let commit = "a".repeat(40), dirty = false;
  const build = "fixture-build";
  const candidate = join(directory, build, "candidate.json");
  const file = join(directory, build, "LXE-Agent-0.2.19-windows-x64.exe");
  const create = async () => {
    mkdirSync(join(directory, build), { recursive: true }); writeFileSync(file, "installer");
    writeJsonAtomic(candidate, { ...release, build_id: build, source_commit: commit, built_at: "2026-09-24T00:00:00Z",
      platform: "windows-x64", file_name: "LXE-Agent-0.2.19-windows-x64.exe", object_key: `artifacts/0.2.19/${build}/LXE-Agent-0.2.19-windows-x64.exe`,
      size: 9, sha512: await sha512(file) });
  };
  const ports: WorkflowPorts = { root, platform: "win32", arch: "x64", source: () => ({ commit, dirty }),
    interactive: true, confirm: async () => "y", log: text => logs.push(text),
    githubRelease: record => {
      expect(calls.at(-1)?.slice(-2)).toEqual(["-Candidate", candidate]);
      githubReleases.push(record);
      return `https://github.com/example/project/releases/tag/v${record.version}`;
    },
    run: async (command, environment) => {
      calls.push(command);
      if (command.includes("desktop:dist:win")) {
        await create();
        writeJsonAtomic(environment.LXE_RELEASE_CANDIDATE_RESULT!, { candidate: `dist/desktop-candidates/${build}/candidate.json` });
      }
    },
  };
  return { root, directory, current, candidate, file, calls, logs, githubReleases, ports, create,
    commit: () => { commit = "b".repeat(40); }, dirty: () => { dirty = true; },
    state: () => JSON.parse(readFileSync(current, "utf8")), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("build installs frozen dependencies, verifies and builds once, then publishes the exact candidate", async () => {
  const f = fixture(); try {
    await runWorkflow("build", f.ports);
    expect(f.calls.map(command => command.slice(1))).toEqual([
      ["install", "--frozen-lockfile"], ["sync", "--frozen"], ["run", "desktop:tools:fd"], ["run", "verify:source"], ["run", "desktop:dist:win"],
    ]);
    expect(f.state()).toMatchObject({ status: "ready", source_commit: "a".repeat(40), candidate: "fixture-build/candidate.json" });
    await runWorkflow("publish", f.ports);
    expect(f.calls.at(-1)?.slice(-2)).toEqual(["-Candidate", f.candidate]);
    expect(f.logs.join("\n")).toContain("测试发布：中文说明");
    expect(f.githubReleases).toEqual([JSON.parse(readFileSync(f.candidate, "utf8"))]);
    expect(f.logs.join("\n")).toContain("GitHub Release: https://github.com/example/project/releases/tag/v0.2.19");
    expect(existsSync(join(f.directory, "workflow.lock"))).toBe(false);
    expect(readdirSync(f.directory).some(name => name.endsWith(".tmp"))).toBe(false);
  } finally { f.cleanup(); }
});
for (const failedStep of ["install", "sync", "desktop:tools:fd", "verify:source", "desktop:dist:win"]) {
  test(`failed ${failedStep} invalidates the old candidate and stops all later stages`, async () => {
    const f = fixture(); try {
      await runWorkflow("build", f.ports); f.calls.length = 0;
      f.logs.length = 0;
      const original = f.ports.run!;
      f.ports.run = async (command, env) => { if (command.includes(failedStep)) throw new Error(`actual ${failedStep} failure`); await original(command, env); };
      await expect(runWorkflow("build", f.ports)).rejects.toThrow(`actual ${failedStep} failure`);
      expect(f.state().status).toBe("failed");
      expect(existsSync(f.file)).toBe(true);
      expect(f.logs.some(line => line.startsWith("Local cleanup"))).toBe(false);
      const count = f.calls.length;
      await expect(runWorkflow("publish", f.ports)).rejects.toThrow("No ready current candidate");
      expect(f.calls.length).toBe(count);
    } finally { f.cleanup(); }
  });
}
for (const scenario of ["missing", "corrupt", "building", "traversal", "commit", "dirty", "notes", "artifact", "missing-artifact"]) {
  test(`publish rejects ${scenario} without starting an upload`, async () => {
    const f = fixture(); try {
      await runWorkflow("build", f.ports); f.calls.length = 0;
      if (scenario === "missing") rmSync(f.current);
      if (scenario === "corrupt") writeFileSync(f.current, "{");
      if (scenario === "building") writeJsonAtomic(f.current, { schema_version: 1, status: "building" });
      if (scenario === "traversal") writeJsonAtomic(f.current, { ...f.state(), candidate: "../candidate.json" });
      if (scenario === "commit") f.commit();
      if (scenario === "dirty") f.dirty();
      if (scenario === "notes") writeJsonAtomic(join(f.root, "config", "desktop-release.json"), { schema_version: 1, version: "0.2.19", notes: "changed" });
      if (scenario === "artifact") writeFileSync(f.file, "tampered!");
      if (scenario === "missing-artifact") rmSync(f.file);
      await expect(runWorkflow("publish", f.ports)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
      expect(f.githubReleases).toHaveLength(0);
    } finally { f.cleanup(); }
  });
}
test("missing result receipt cannot silently choose an older candidate", async () => {
  const f = fixture(); try {
    await runWorkflow("build", f.ports); f.ports.run = async () => {};
    await expect(runWorkflow("build", f.ports)).rejects.toThrow();
    expect(f.state().status).toBe("failed");
  } finally { f.cleanup(); }
});
test("source changes during verification stop packaging", async () => {
  const f = fixture(); try {
    const original = f.ports.run!;
    f.ports.run = async (command, env) => { await original(command, env); if (command.includes("verify:source")) f.commit(); };
    await expect(runWorkflow("build", f.ports)).rejects.toThrow("Source changed during verification");
    expect(f.calls.some(command => command.includes("desktop:dist:win"))).toBe(false);
  } finally { f.cleanup(); }
});
test("concurrent workflow is rejected without altering the owner's building state", async () => {
  const f = fixture(); try {
    const original = f.ports.run!; let checked = false;
    f.ports.run = async (command, env) => {
      if (!checked) { checked = true;
        await expect(runWorkflow("build", f.ports)).rejects.toThrow("locked");
        await expect(runWorkflow("publish", f.ports)).rejects.toThrow("locked");
        expect(f.state().status).toBe("building");
      }
      await original(command, env);
    };
    await runWorkflow("build", f.ports);
  } finally { f.cleanup(); }
});
for (const scenario of ["cancel", "noninteractive", "change-during-confirm", "publish-retry"]) {
  test(`publication handles ${scenario}`, async () => {
    const f = fixture(); try {
      await runWorkflow("build", f.ports); f.calls.length = 0;
      if (scenario === "cancel") { f.ports.confirm = async () => "n"; await runWorkflow("publish", f.ports); }
      if (scenario === "noninteractive") { f.ports.interactive = false; await expect(runWorkflow("publish", f.ports)).rejects.toThrow("interactive terminal"); }
      if (scenario === "change-during-confirm") { f.ports.confirm = async () => { f.commit(); return "y"; }; await expect(runWorkflow("publish", f.ports)).rejects.toThrow("differs"); }
      if (scenario === "publish-retry") {
        const original = f.ports.run!; f.ports.run = async () => { throw new Error("actual upload failure"); };
        await expect(runWorkflow("publish", f.ports)).rejects.toThrow("actual upload failure");
        expect(f.githubReleases).toHaveLength(0);
        expect(f.state().status).toBe("ready");
        f.ports.run = original; await runWorkflow("publish", f.ports); expect(f.calls).toHaveLength(1);
      } else { expect(f.calls).toHaveLength(0); expect(f.githubReleases).toHaveLength(0); }
    } finally { f.cleanup(); }
  });
}
test("atomic writes replace existing state without leaving temporary files", () => {
  const f = fixture(); try {
    mkdirSync(f.directory, { recursive: true });
    writeJsonAtomic(f.current, { status: "building" }); writeJsonAtomic(f.current, { status: "ready" });
    expect(f.state().status).toBe("ready"); expect(readdirSync(f.directory)).toEqual(["current.json"]);
  } finally { f.cleanup(); }
});
test("cleanup failure does not invalidate a successful build", async () => {
  const f = fixture(); try {
    mkdirSync(f.directory, { recursive: true }); writeFileSync(join(f.directory, "last-published.json"), "corrupt");
    await runWorkflow("build", f.ports);
    expect(f.state().status).toBe("ready"); expect(existsSync(f.file)).toBe(true);
    expect(f.logs.join("\n")).toContain("Local cleanup skipped:");
  } finally { f.cleanup(); }
});
test("unsupported platforms stop before creating release state", async () => {
  const f = fixture(); try {
    await expect(runWorkflow("build", { ...f.ports, platform: "darwin" })).rejects.toThrow("Windows x64");
    expect(existsSync(f.current)).toBe(false);
  } finally { f.cleanup(); }
});

test("a source change during packaging fails instead of recording a ready candidate", async () => {
  const f = fixture(); try {
    const original = f.ports.run!;
    f.ports.run = async (command, env) => { await original(command, env); if (command.includes("desktop:dist:win")) f.commit(); };
    await expect(runWorkflow("build", f.ports)).rejects.toThrow("Source changed during build");
    expect(f.state().status).toBe("failed");
  } finally { f.cleanup(); }
});
test("publisher rejects metadata replacement during confirmation", async () => {
  const f = fixture(); try {
    await runWorkflow("build", f.ports); f.calls.length = 0;
    f.ports.confirm = async () => {
      const record = JSON.parse(readFileSync(f.candidate, "utf8"));
      writeJsonAtomic(f.candidate, { ...record, notes: "replaced" }); return "y";
    };
    await expect(runWorkflow("publish", f.ports)).rejects.toThrow("Candidate changed during confirmation");
    expect(f.calls).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("GitHub failure reports COS success, keeps the candidate ready and permits retry", async () => {
  const f = fixture(); try {
    await runWorkflow("build", f.ports);
    const original = f.ports.githubRelease!;
    f.ports.githubRelease = () => { throw new Error("gh: Bad credentials (HTTP 401)"); };
    await expect(runWorkflow("publish", f.ports)).rejects.toThrow("COS publication succeeded; GitHub Release recording failed");
    expect(f.state().status).toBe("ready");
    expect(existsSync(join(f.directory, "workflow.lock"))).toBe(false);
    await expect(runWorkflow("publish", f.ports)).rejects.toThrow("gh: Bad credentials (HTTP 401)");
    f.ports.githubRelease = original;
    await runWorkflow("publish", f.ports);
    expect(f.githubReleases).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("GitHub receives the published candidate even if HEAD changes while uploading", async () => {
  const f = fixture(); try {
    await runWorkflow("build", f.ports);
    const original = f.ports.run!;
    f.ports.run = async (command, env) => { await original(command, env); f.commit(); };
    await runWorkflow("publish", f.ports);
    expect(f.githubReleases[0]?.source_commit).toBe("a".repeat(40));
  } finally { f.cleanup(); }
});
