import { expect, test } from "bun:test";
import { publishGitHubRelease } from "./github-release";

const candidate = { version: "0.3.3", notes: "中文说明\n第二行 `literal` $(unchanged) \\", source_commit: "a".repeat(40) };
const base = "repos/LXE123/LXE_AGENT", tag = "v0.3.3";
const url = `https://github.com/LXE123/LXE_AGENT/releases/tag/${tag}`;
const response = (code: number, body: unknown, stderr = "") => ({
  status: code >= 400 ? 1 : 0, stdout: `HTTP/2.0 ${code} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr,
});

function fixture() {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let origin = "git@github.com:LXE123/LXE_AGENT.git";
  let commit: string | undefined;
  let annotated = false;
  let existing: { tag_name: string; html_url: string; draft: boolean; prerelease: boolean } | undefined;
  let failure: ReturnType<typeof response> | undefined;
  let afterCreate = () => {};
  const run: NonNullable<Parameters<typeof publishGitHubRelease>[2]> = (command, args, input) => {
    if (command === "git") {
      expect(args).toEqual(["remote", "get-url", "origin"]);
      return { status: 0, stdout: origin, stderr: "" };
    }
    expect(command).toBe("gh");
    expect(args.slice(0, 4)).toEqual(["api", "--hostname", "github.com", "--include"]);
    const method = args[5]!, path = args[6]!;
    const body = input === undefined ? undefined : JSON.parse(input);
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (failure) return failure;
    if (path === `${base}/git/ref/tags/${tag}`) {
      return commit ? response(200, { object: { type: annotated ? "tag" : "commit", sha: annotated ? "c".repeat(40) : commit } })
        : response(404, { message: "Not Found" }, "gh: Not Found (HTTP 404)");
    }
    if (path === `${base}/commits/refs%2Ftags%2F${tag}`) return response(200, { sha: commit });
    if (path === `${base}/releases/tags/${tag}`) return existing ? response(200, existing) : response(404, { message: "Not Found" });
    expect(path).toBe(`${base}/releases`);
    expect(method).toBe("POST");
    expect(args.slice(7)).toEqual(["--input", "-"]);
    commit ??= body.target_commitish;
    existing = { tag_name: tag, html_url: url, draft: false, prerelease: false };
    afterCreate();
    return response(201, existing);
  };
  return { run, requests, origin: (value: string) => { origin = value; },
    tag: (value: string, annotatedTag = false) => { commit = value; annotated = annotatedTag; },
    release: (options: { draft?: boolean; prerelease?: boolean } = {}) => {
      existing = { tag_name: tag, html_url: url, draft: false, prerelease: false, ...options };
    },
    fail: (value: ReturnType<typeof response>) => { failure = value; },
    afterCreate: (action: () => void) => { afterCreate = action; },
  };
}

test("creates a metadata-only release at the built commit and preserves the exact notes", () => {
  const f = fixture();
  expect(publishGitHubRelease("unused", candidate, f.run)).toBe(url);
  expect(f.requests.filter(request => request.method === "POST")).toEqual([{
    method: "POST", path: `${base}/releases`, body: {
      tag_name: tag, name: tag, target_commitish: candidate.source_commit, body: candidate.notes,
      draft: false, prerelease: false,
    },
  }]);
  // Repeating the operation must not create another release or overwrite edited release notes.
  expect(publishGitHubRelease("unused", candidate, f.run)).toBe(url);
  expect(f.requests.filter(request => request.method !== "GET")).toHaveLength(1);
});

for (const remote of ["https://github.com/LXE123/LXE_AGENT.git", "https://github.com/LXE123/LXE_AGENT", "ssh://git@github.com/LXE123/LXE_AGENT.git"]) {
  test(`resolves the release repository from ${remote}`, () => {
    const f = fixture(); f.origin(remote);
    expect(publishGitHubRelease("unused", candidate, f.run)).toBe(url);
  });
}

for (const annotated of [false, true]) {
  test(`reuses a matching ${annotated ? "annotated" : "lightweight"} tag when creating a release`, () => {
    const f = fixture(); f.tag(candidate.source_commit, annotated);
    expect(publishGitHubRelease("unused", candidate, f.run)).toBe(url);
  });
  test(`refuses a conflicting ${annotated ? "annotated" : "lightweight"} tag without remote writes`, () => {
    const f = fixture(); f.tag("b".repeat(40), annotated); f.release();
    expect(() => publishGitHubRelease("unused", candidate, f.run)).toThrow("The tag was not moved");
    expect(f.requests.every(request => request.method === "GET")).toBe(true);
  });
}

for (const flags of [{ draft: true }, { prerelease: true }]) {
  test(`does not silently publish or change an existing ${JSON.stringify(flags)} release`, () => {
    const f = fixture(); f.tag(candidate.source_commit); f.release(flags);
    expect(() => publishGitHubRelease("unused", candidate, f.run)).toThrow("not a published stable release");
    expect(f.requests.every(request => request.method === "GET")).toBe(true);
  });
}

test("verifies the actual tag after creation instead of trusting target_commitish", () => {
  const f = fixture(); f.afterCreate(() => f.tag("b".repeat(40)));
  expect(() => publishGitHubRelease("unused", candidate, f.run)).toThrow("The tag was not moved");
});

for (const failure of [response(401, { message: "Bad credentials" }, "gh: Bad credentials (HTTP 401)"),
  response(403, { message: "API rate limit exceeded" }, "gh: API rate limit exceeded (HTTP 403)"),
  { status: 1, stdout: "", stderr: "dial tcp: connection refused" }]) {
  test(`retains the actual GitHub error: ${failure.stderr}`, () => {
    const f = fixture(); f.fail(failure);
    expect(() => publishGitHubRelease("unused", candidate, f.run)).toThrow(failure.stderr);
    expect(f.requests).toHaveLength(1);
  });
}

test("reports a missing GitHub CLI instead of treating it as a missing tag", () => {
  const f = fixture();
  expect(() => publishGitHubRelease("unused", candidate, (command, args, input) => command === "gh"
    ? { status: null, stdout: "", stderr: "", error: new Error("spawnSync gh ENOENT") }
    : f.run(command, args, input))).toThrow("spawnSync gh ENOENT");
});

test("reports a rejected creation, including an unavailable source commit", () => {
  const f = fixture();
  expect(() => publishGitHubRelease("unused", candidate, (command, args, input) => command === "gh" && args[5] === "POST"
    ? response(422, { message: "Validation Failed", errors: [{ field: "target_commitish", code: "invalid" }] }, "gh: Validation Failed (HTTP 422)")
    : f.run(command, args, input))).toThrow("target_commitish");
});

test("retry finds the existing release when creation succeeded but its response was lost", () => {
  const f = fixture();
  expect(() => publishGitHubRelease("unused", candidate, (command, args, input) => {
    const result = f.run(command, args, input);
    return command === "gh" && args[5] === "POST" ? { status: 1, stdout: "", stderr: "unexpected EOF" } : result;
  })).toThrow("unexpected EOF");
  expect(publishGitHubRelease("unused", candidate, f.run)).toBe(url);
  expect(f.requests.filter(request => request.method === "POST")).toHaveLength(1);
});

test("rejects an unsupported origin without contacting GitHub", () => {
  const f = fixture(); f.origin("https://example.org/LXE123/LXE_AGENT.git");
  expect(() => publishGitHubRelease("unused", candidate, f.run)).toThrow("github.com repository as origin");
  expect(f.requests).toHaveLength(0);
});
