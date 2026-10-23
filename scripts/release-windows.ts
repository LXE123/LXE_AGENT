// Keep this entry point dependency-free: it installs frozen dependencies before loading build tools.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { VERSION, verifyCandidate, writeJsonAtomic, type ReleaseCandidate } from "./release-candidate";

import { cleanupCandidates } from "./release-retention";
import { publishGitHubRelease } from "./github-release";

type Action = "build" | "publish";
interface Source { commit: string; dirty: boolean }
interface Current {
  schema_version: 1; status: "building" | "failed" | "ready";
  source_commit?: string; candidate?: string; error?: string;
}
export interface WorkflowPorts {
  root: string;
  platform?: string; arch?: string;
  source?: () => Source;
  run?: (command: string[], environment: Record<string, string>) => Promise<void>;
  interactive?: boolean;
  confirm?: () => Promise<string>;
  log?: (text: string) => void;
  githubRelease?: (candidate: ReleaseCandidate) => string | Promise<string>;
}
export async function runWorkflow(action: Action, ports: WorkflowPorts): Promise<void> {
  if ((ports.platform ?? process.platform) !== "win32" || (ports.arch ?? process.arch) !== "x64") {
    throw new Error("Release commands require Windows x64");
  }
  const root = resolve(ports.root), directory = join(root, "dist", "desktop-candidates");
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "workflow.lock"), currentPath = join(directory, "current.json");
  try { mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Release workflow locked: ${lock}. Remove only after confirming the previous process has stopped.`);
  }
  const log = ports.log ?? console.log;
  const source = ports.source ?? (() => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    return { commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain")) };
  });
  const intent = () => {
    const value = JSON.parse(readFileSync(join(root, "config", "desktop-release.json"), "utf8"));
    if (value.schema_version !== 1 || !VERSION.test(value.version) || typeof value.notes !== "string" || !value.notes.trim()) {
      throw new Error("Prepare and commit config/desktop-release.json with version and notes");
    }
    return value as { version: string; notes: string };
  };
  const cleanSource = () => {
    const value = source();
    if (value.dirty) throw new Error("Working tree is dirty; commit changes and rebuild");
    if (!/^[a-f0-9]{40}$/.test(value.commit)) throw new Error("Invalid source commit");
    return value.commit;
  };
  const run = ports.run ?? (async (command, environment) => {
    const child = Bun.spawn(command, { cwd: root, env: { ...process.env, ...environment }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) throw new Error(`${command[0]} ${command.slice(1).join(" ")} failed with exit code ${code}`);
  });
  const stage = async (label: string, command: string[], environment: Record<string, string> = {}) => {
    log(`==> ${label}`); const start = performance.now();
    try { await run(command, environment); }
    finally { log(`<== ${label}: ${((performance.now() - start) / 1000).toFixed(2)}s`); }
  };
  const matches = (record: ReleaseCandidate, commit: string, release: { version: string; notes: string }) => {
    if (record.source_commit !== commit || record.version !== release.version || record.notes !== release.notes) {
      throw new Error("Candidate differs from current source or release notes; rebuild with bun run release:build");
    }
  };
  let state: Current = { schema_version: 1, status: "building" };
  try {
    if (action === "build") {
      const receipt = join(lock, "candidate-result.json");
      try {
        writeJsonAtomic(currentPath, state);
        const commit = cleanSource(), release = intent();
        state.source_commit = commit; writeJsonAtomic(currentPath, state);
        const bun = process.execPath;
        await stage("Install frozen Bun dependencies", [bun, "install", "--frozen-lockfile"]);
        await stage("Sync frozen Python dependencies", ["uv", "sync", "--frozen"]);
        await stage("Prepare fd", [bun, "run", "desktop:tools:fd"]);
        await stage("Verify source", [bun, "run", "verify:source"]);
        if (cleanSource() !== commit || JSON.stringify(intent()) !== JSON.stringify(release)) throw new Error("Source changed during verification; rebuild");
        await stage("Build NSIS candidate", [bun, "run", "desktop:dist:win"], { LXE_RELEASE_CANDIDATE_RESULT: receipt });
        const result = JSON.parse(readFileSync(receipt, "utf8"));
        const path = resolve(root, result.candidate);
        const candidate = relative(directory, path).replaceAll("\\", "/");
        if (!/^[a-zA-Z0-9_-]{1,100}\/candidate\.json$/.test(candidate)) throw new Error("Invalid candidate result path");
        const record = await verifyCandidate(path);
        if (candidate !== `${record.build_id}/candidate.json`) throw new Error("Candidate result identity mismatch");
        matches(record, commit, release);
        if (cleanSource() !== commit) throw new Error("Source changed during build; rebuild");
        matches(record, commit, intent());
        state = { schema_version: 1, status: "ready", source_commit: commit, candidate };
        writeJsonAtomic(currentPath, state);
        cleanupCandidates(directory, record.build_id, log);
        log(`Ready to publish: ${record.version} / ${record.build_id}\nRun bun run release:publish after checking the installer.`);
      } catch (error) {
        writeJsonAtomic(currentPath, { ...state, status: "failed", error: String(error) });
        throw error;
      }
      return;
    }
    let current: Current;
    try { current = JSON.parse(readFileSync(currentPath, "utf8")); }
    catch (error) { throw new Error(`Cannot read current candidate; run bun run release:build. ${error}`); }
    if (current.schema_version !== 1 || current.status !== "ready" || typeof current.candidate !== "string"
      || !/^[a-zA-Z0-9_-]{1,100}\/candidate\.json$/.test(current.candidate)) {
      throw new Error("No ready current candidate; run bun run release:build");
    }
    const path = join(directory, current.candidate), commit = cleanSource();
    const record = await verifyCandidate(path);
    if (current.source_commit !== commit || current.candidate !== `${record.build_id}/candidate.json`) throw new Error("Current candidate is stale; rebuild");
    matches(record, commit, intent());
    log(`Version: ${record.version}\nBuilt: ${record.built_at}\nSource: ${record.source_commit}\nBuild: ${record.build_id}\nSize: ${(record.size / 1024 / 1024).toFixed(2)} MiB\nNotes:\n${record.notes}`);
    if (!(ports.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) throw new Error("Publishing requires an interactive terminal; no files uploaded");
    const answer = await (ports.confirm ?? (async () => {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { return await input.question("Publish to the stable channel and record a GitHub Release? Type y to publish: "); }
      finally { input.close(); }
    }))();
    if (answer.trim() !== "y") { log("Publication cancelled; no files uploaded."); return; }
    // Recheck after the user prompt; source and artifacts may have changed while waiting.
    matches(record, cleanSource(), intent());
    if (JSON.stringify(await verifyCandidate(path)) !== JSON.stringify(record)) throw new Error("Candidate changed during confirmation; rebuild");
    await stage("Publish candidate", ["powershell", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "publish-desktop-windows.ps1"), "-Candidate", path]);
    try {
      log("==> Record GitHub Release");
      const url = await (ports.githubRelease ?? (candidate => publishGitHubRelease(root, candidate)))(record);
      log(`GitHub Release: ${url}`);
    } catch (error) {
      throw new Error(`COS publication succeeded; GitHub Release recording failed. The client update is already available.\n${error instanceof Error ? error.message : String(error)}\nInstall GitHub CLI and authenticate with gh auth login if needed, ensure the built commit is pushed to origin, then retry bun run release:publish with this same candidate. Do not rebuild or change the version just to retry GitHub.`);
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const action = process.argv[2];
  if (action !== "build" && action !== "publish") { console.error("Use build or publish"); process.exitCode = 1; }
  else await runWorkflow(action, { root: resolve(import.meta.dir, "..") }).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
