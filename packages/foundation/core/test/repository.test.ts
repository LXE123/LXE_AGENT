import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { repositoryRoot } from "../src/repository";

describe("repositoryRoot", () => {
  test("finds the repository from nested workspace directories", () => {
    const root = repositoryRoot(import.meta.dir);
    expect(repositoryRoot(join(root, "apps", "gateway", "src", "channels", "feishu"))).toBe(root);
    expect(repositoryRoot(join(root, "packages", "agent", "runtime", "test"))).toBe(root);
  });

  test("fails when no LXE repository markers exist", () => {
    expect(() => repositoryRoot("/")).toThrow("LXE repository root not found");
  });
});
