import { spawnSync } from "node:child_process";
import type { ReleaseCandidate } from "./release-candidate";

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
type RunCommand = (command: string, args: string[], input?: string) => CommandResult;
type ReleaseIdentity = Pick<ReleaseCandidate, "version" | "notes" | "source_commit">;
interface TagRef { object: { type: string; sha: string } }
interface GitHubRelease { tag_name: string; html_url: string; draft: boolean; prerelease: boolean }

function commandError(command: string, result: CommandResult): Error {
  const detail = [result.error?.message, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return new Error(`${command} failed (exit ${result.status}): ${detail.slice(0, 8000)}${detail.length > 8000 ? " [truncated]" : ""}`);
}

/** Record an already published COS candidate. Never upload assets or move an existing tag. */
export function publishGitHubRelease(root: string, candidate: ReleaseIdentity, run?: RunCommand): string {
  const execute: RunCommand = run ?? ((command, args, input) => spawnSync(command, args, {
    cwd: root, encoding: "utf8", input, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  }));
  const origin = execute("git", ["remote", "get-url", "origin"]);
  if (origin.error || origin.status !== 0) throw commandError("git remote get-url origin", origin);
  const repository = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin.stdout.trim())?.[1];
  if (!repository) throw new Error("GitHub Release requires a github.com repository as origin");
  const base = `repos/${repository}`, tag = `v${candidate.version}`;

  function api<T>(method: "GET" | "POST", path: string, body?: object, allowMissing = false): T | undefined {
    const args = ["api", "--hostname", "github.com", "--include", "--method", method, path];
    if (body) args.push("--input", "-");
    // JSON through stdin preserves Chinese, newlines and shell metacharacters on Windows.
    const result = execute("gh", args, body ? JSON.stringify(body) : undefined);
    if (result.error) throw commandError("gh api", result);
    const status = /^HTTP\/[\d.]+\s+(\d{3})\b/.exec(result.stdout)?.[1];
    if (allowMissing && status === "404") return undefined;
    if (result.status !== 0 || !status?.startsWith("2")) throw commandError("gh api", result);
    const separator = /\r?\n\r?\n/.exec(result.stdout);
    if (!separator) throw new Error("gh api returned no HTTP response body");
    return JSON.parse(result.stdout.slice(separator.index + separator[0].length)) as T;
  }

  function tagCommit(): string | undefined {
    const ref = api<TagRef>("GET", `${base}/git/ref/tags/${tag}`, undefined, true);
    if (!ref) return undefined;
    if (ref.object.type === "commit") return ref.object.sha;
    // Annotated tags point to a tag object; resolve the commit rather than comparing that object's SHA.
    if (ref.object.type === "tag") {
      return api<{ sha: string }>("GET", `${base}/commits/${encodeURIComponent(`refs/tags/${tag}`)}`)!.sha;
    }
    throw new Error(`GitHub tag ${tag} points to unsupported object type ${ref.object.type}`);
  }

  function assertCommit(commit: string | undefined): void {
    if (commit !== candidate.source_commit) {
      throw new Error(`GitHub tag ${tag} points to ${commit ?? "a missing commit"}; built source is ${candidate.source_commit}. The tag was not moved.`);
    }
  }
  const existingCommit = tagCommit();
  if (existingCommit !== undefined) assertCommit(existingCommit);
  const existing = api<GitHubRelease>("GET", `${base}/releases/tags/${tag}`, undefined, true);
  if (existing) {
    assertCommit(existingCommit);
    if (existing.draft || existing.prerelease || existing.tag_name !== tag) {
      throw new Error(`Existing GitHub Release ${tag} is not a published stable release (draft=${existing.draft}, prerelease=${existing.prerelease}); review it manually.`);
    }
    return existing.html_url;
  }
  const release = api<GitHubRelease>("POST", `${base}/releases`, {
    tag_name: tag, target_commitish: candidate.source_commit, name: tag, body: candidate.notes,
    draft: false, prerelease: false,
  })!;
  // Re-read the actual tag: target_commitish is ignored by GitHub when a tag already exists.
  assertCommit(tagCommit());
  return release.html_url;
}
