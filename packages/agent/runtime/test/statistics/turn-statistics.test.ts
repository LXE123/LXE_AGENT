import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { TurnStatistics, type TurnStatisticsOptions } from "../../src/statistics/turn-statistics";
import { skillPathKey } from "../../src/tooling/skill-files";
import { removeTemporaryRoot } from "../temp-directory";

const root = mkdtempSync(join(tmpdir(), "turn-skill-use-"));
const workspace = join(root, "workspace");
const repoSkill = "skills/repo";
const userSkill = join(root, "user skills", "external");
const doc = repoSkill + "/SKILL.md";
const script = repoSkill + "/scripts/nested/task";
const extensions = ["py", "sh", "js", "ts", "rb", "pl", "ps1", "mjs", "cjs", "cmd", "bat"];
const locations: Record<string, string> = {};

beforeAll(() => {
  for (const file of [
    join(workspace, doc), join(userSkill, "SKILL.md"), join(workspace, repoSkill, "references/x.md"),
    join(workspace, repoSkill, "outside.py"), join(workspace, repoSkill, "scripts-old/test.py"),
    ...extensions.map(ext => join(workspace, script + "." + ext)),
  ]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture");
  }
  symlinkSync(userSkill, join(workspace, "alias"), "junction");
  locations[skillPathKey(join(workspace, doc))] = "repo";
  locations[skillPathKey(join(userSkill, "SKILL.md"))] = "external";
});
afterAll(() => removeTemporaryRoot(root));

const catalog = async () => [
  { command: "lxeskill demo", skill: "external" },
  { command: "lxeskill demo inspect", skill: "repo" },
];
const turn = (options: Partial<TurnStatisticsOptions> = {}) => {
  const stats = new TurnStatistics({ directory: workspace, commandSkills: catalog, ...options });
  stats.setSkills(locations, { repo: "business", external: "user" });
  return stats;
};
const repoUse = { skill: "repo", module: "business", source: "implicit" } as const;
const userUse = { skill: "external", module: "user", source: "implicit" } as const;

for (const shell of ["posix", "powershell"] as const) {
  describe(shell, () => {
    test.each([
      "cat", "BAT.EXE --line-range 1:50", "batcat", "less", "more", "head -n 50", "tail -n +1",
      "awk '{print $1}'", "nl -ba", "sed -n '1,200p'", "Get-Content -Path", "Get-Content -LiteralPath",
      "Get-Content -TotalCount 50", "gc -Raw", "type",
      "Get-Content -Raw -Encoding utf8 -Path", "Get-Content -Tail 20 -Encoding UTF8", "gc -First 40",
    ])("%s reads an indexed manifest", async reader => {
      const stats = turn({ shell });
      stats.observe("exec", { command: reader + " " + doc });
      expect((await stats.snapshot()).uses).toEqual([repoUse]);
    });

    test.each([
      ["cat", " 2>/dev/null"], ["head -n 50", " 2>&1"], ["cat", " > out.txt"], ["sed -n '1,80p'", " 2> err.log"],
      ["Get-Content -Encoding utf8", " 2>$null"], ["gc", " *> out.txt"],
    ])("%s with redirection%s still reads the manifest", async (reader, redirect) => {
      const stats = turn({ shell });
      stats.observe("exec", { command: reader + " " + doc + redirect });
      expect((await stats.snapshot()).uses).toEqual([repoUse]);
    });

    test.each(["Get-Content -Encoding", "Get-Content -Wait"])("%s without a file operand does not count", async reader => {
      const stats = turn({ shell });
      stats.observe("exec", { command: reader + " " + doc });
      expect((await stats.snapshot()).uses).toEqual([]);
    });

    test.each([
      ["python -X utf8", "py"], ["python3 -W ignore -E", "py"], ["py.exe -3", "py"],
      ["bash -e", "sh"], ["zsh", "sh"], ["sh", "sh"], ["NoDe.ExE", "js"], ["node", "mjs"], ["node", "cjs"],
      ["deno", "ts"], ["deno run --allow-read", "ts"], ["ruby", "rb"], ["perl", "pl"],
      ["pwsh -NoProfile -File", "ps1"], ["PowerShell.exe -File", "ps1"],
      ["uv run", "py"], ["UV.EXE RUN --frozen python -X utf8", "py"], ["npx tsx", "ts"],
    ])("%s runs a skill script (%s)", async (runner, ext) => {
      const stats = turn({ shell });
      stats.observe("exec", { command: runner + " " + script + "." + ext + " --user-arg" });
      expect((await stats.snapshot()).uses).toEqual([repoUse]);
    });

    test.each([
      "cat " + repoSkill + "/references/x.md", "sed -n 's/old/new/p' " + doc, "sed -i -n '1p' " + doc,
      ...["ls", "find", "grep", "rg", "fd", "tree", "python"].map(tool => tool + " " + doc),
      "python " + repoSkill + "/outside.py", "node " + repoSkill + "/scripts-old/test.py",
      "python -m " + script + ".py", "py -c " + script + ".py", "python -X " + script + ".py",
      "python -Im " + script + ".py", "uv run -m " + script + ".py",
      "node --require " + script + ".js outside.js", "node --eval " + script + ".js",
      "echo 'a | cat " + doc + "'", "bash -c 'sh -c \"cat " + doc + "\"'",
    ])("skips %s", async command => {
      const stats = turn({ shell });
      stats.observe("exec", { command });
      expect((await stats.snapshot()).uses).toEqual([]);
    });

    test.each([
      ["cd skills && cd repo && cat SKILL.md", repoUse],
      ["cat missing | cat alias/SKILL.md", userUse],
      ['pushd "../user skills" ; cat external/SKILL.md', userUse],
      ["echo 'a || b' && cat " + doc, repoUse],
      ["echo $(echo ignored; cat alias/SKILL.md) && cat " + doc, repoUse],
      ["lxeskill demo | cat " + doc, repoUse],
      ["lxeskill list; cat " + doc, repoUse],
      ["cat alias/SKILL.md ; lxeskill demo inspect", userUse],
      ["echo first; ./" + script + ".cmd && cat alias/SKILL.md", repoUse],
      ["bash -lc 'cd skills/repo && cat SKILL.md'", repoUse],
      ["sh -c 'cat alias/SKILL.md'", userUse],
      ["zsh -lc 'cat " + doc + "'", repoUse],
      ["powershell.exe -NoProfile -c 'Set-Location skills/repo; type SKILL.md'", repoUse],
      ['pwsh -Command "sl skills\\repo; Get-Content .\\SKILL.md -TotalCount 5"', repoUse],
      ["bash -c 'cd skills/repo' && cat alias/SKILL.md", userUse],
    ] as const)("attributes only the first matching segment in %s", async (command, expected) => {
      const stats = turn({ shell });
      stats.observe("exec", { command });
      expect((await stats.snapshot()).uses).toEqual([expected]);
    });

    test.each([
      "cat README.md >/dev/null || cat " + doc,
      "test -f x.md || cat " + doc + " | head -n 5",
      "cat missing ||\n  cat " + doc,
      "false || cd skills/repo; cat SKILL.md",
      "lxeskill demo inspect",
    ])("does not count %s", async command => {
      const stats = turn({ shell });
      stats.observe("exec", { command });
      expect((await stats.snapshot()).uses).toEqual([]);
    });

    test.each([
      ["false || echo fallback; cat " + doc, repoUse],
      ["cat missing || echo fallback && cat alias/SKILL.md", userUse],
      ["echo start\ncat missing || true\ncat " + doc, repoUse],
    ] as const)("counts commands after a fallback ends in %s", async (command, expected) => {
      const stats = turn({ shell });
      stats.observe("exec", { command });
      expect((await stats.snapshot()).uses).toEqual([expected]);
    });
  });
}

test("POSIX backslash escapes spaces and quoted operators are literal", async () => {
  const stats = turn({ shell: "posix" });
  stats.observe("exec", { command: "echo '|| lxeskill demo inspect' && cat ../user\\ skills/external/SKILL.md" });
  expect((await stats.snapshot()).uses).toEqual([userUse]);
});

test("a statistics lookup error leaves the observed tool call intact", async () => {
  const failure = new Error("snapshot location unavailable");
  const errors: unknown[] = [];
  const stats = turn({ onError: error => errors.push(error) });
  stats.setSkills({ get [skillPathKey(join(workspace, doc))](): string { throw failure; } }, {});
  stats.observe("exec", { command: "cat " + doc });
  stats.finish("exec", 7, false);
  expect(errors).toEqual([failure]);
  expect(await stats.snapshot()).toMatchObject({ tools: [{ calls: 1, errors: 0, duration_ms: 7 }], uses: [] });
});

test("PowerShell paths, call operator, relative cwd and executable suffixes", async () => {
  for (const command of [
    '.\\scripts\\nested\\task.bat', '& ".\\scripts\\nested\\task.ps1"',
    "SET-LOCATION scripts; sl nested; ..\\nested\\task.cmd",
    'gc.exe -LiteralPath ".\\SKILL.md" -Raw',
  ]) {
    const stats = turn({ shell: "powershell" });
    stats.observe("exec", { command, cwd: "skills\\repo" });
    expect((await stats.snapshot()).uses).toEqual([repoUse]);
  }
});

test("resolves an absolute path and a home-relative cwd outside the workspace", async () => {
  const stats = turn({ shell: "powershell" });
  stats.observe("exec", { command: '& "' + join(workspace, script + ".ps1").replaceAll("/", "\\") + '"' });
  const rel = relative(homedir(), userSkill).split(sep).join("/");
  stats.observe("exec", { command: "cat SKILL.md", cwd: "~/" + rel });
  expect((await stats.snapshot()).uses).toEqual([repoUse, userUse]);
});

test("deduplicates manifest reads and scripts, keeping explicit precedence", async () => {
  const stats = turn();
  stats.observe("read", { path: doc, offset: 10, limit: 3 });
  stats.observe("exec", { command: "node " + script + ".js" });
  stats.observe("exec", { command: "lxeskill demo" });
  expect(await stats.snapshot()).toMatchObject({
    uses: [repoUse], activations: [{ skill: "repo" }], executions: [{ skill: "external", command: "demo" }],
  });
  stats.recordUse("repo", "explicit");
  stats.observe("read", { path: doc });
  expect((await stats.snapshot()).uses).toEqual([{ ...repoUse, source: "explicit" }]);
});

test("lxeskill commands feed only local command counts, not skill uses", async () => {
  const stats = turn();
  stats.observe("exec", { command: "lxeskill demo inspect --arg" });
  expect(await stats.snapshot()).toMatchObject({ uses: [], executions: [{ skill: "repo", command: "demo inspect" }] });
});
