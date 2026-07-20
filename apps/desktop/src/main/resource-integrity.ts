import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

interface ResourceManifestFile {
  path: string;
  size: number;
  sha256: string;
  owner: string;
  policy: "editable" | "immutable";
  integrity: string;
}

interface ResourceManifest {
  schema_version: number;
  platform: string;
  files: ResourceManifestFile[];
}

const hashFile = async (path: string): Promise<string> => await new Promise((resolveHash, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.once("error", reject);
  stream.once("end", () => resolveHash(hash.digest("hex")));
});

const ownedPath = (root: string, manifestPath: string): string => {
  if (!manifestPath || isAbsolute(manifestPath) || manifestPath.includes("\0")) {
    throw new Error(`Resource manifest path is invalid: ${manifestPath}`);
  }
  const path = resolve(root, manifestPath);
  const relation = relative(root, path);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Resource manifest path escapes resources: ${manifestPath}`);
  }
  return path;
};

const validateEditableFile = (entry: ResourceManifestFile, path: string): void => {
  const maximum = entry.path === "agent/SOUL.md"
    ? 256 * 1024
    : entry.path.endsWith("/SKILL.md") ? 1024 * 1024 : 128 * 1024 * 1024;
  const size = statSync(path).size;
  if (size <= 0 || size > maximum) {
    throw new Error(`Editable resource size is invalid: ${entry.path} (${size} bytes)`);
  }
  if (entry.path === "agent/SOUL.md") {
    const soul = readFileSync(path, "utf8").trim();
    if (!soul) throw new Error(`SOUL.md must not be empty: ${path}`);
  }
  if (entry.path.endsWith("/SKILL.md")) {
    const content = readFileSync(path, "utf8");
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u)?.[1] ?? "";
    if (!frontmatter || !/^name:\s*\S+/mu.test(frontmatter)) {
      throw new Error(`Skill is missing valid YAML frontmatter and name: ${path}`);
    }
  }
};

export const verifyDesktopResourceManifest = async (
  resourcesRoot: string,
  manifestPath: string,
  platform: string,
): Promise<void> => {
  const root = resolve(resourcesRoot);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ResourceManifest;
  if (manifest.schema_version !== 2 || manifest.platform !== platform || !Array.isArray(manifest.files)) {
    throw new Error(`Desktop resource manifest is incompatible: ${manifestPath}`);
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry.path || seen.has(entry.path) || !entry.owner || !entry.sha256
      || !["editable", "immutable"].includes(entry.policy)) {
      throw new Error(`Desktop resource manifest entry is invalid: ${entry.path}`);
    }
    seen.add(entry.path);
    const path = ownedPath(root, entry.path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Desktop resource file is missing: ${entry.path}`);
    }
    if (entry.policy === "editable") {
      validateEditableFile(entry, path);
      continue;
    }
    const actual = await hashFile(path);
    if (actual !== entry.sha256) {
      throw new Error(`Desktop resource SHA-256 mismatch: ${entry.path}`);
    }
  }
};
