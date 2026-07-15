import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const lockInputPaths = [
  "config/desktop-runtime/windows-x64/runtime.lock.json",
  "config/desktop-runtime/windows-x64/node/package.json",
  "config/desktop-runtime/windows-x64/node/package-lock.json",
  "pyproject.toml",
  "uv.lock",
] as const;

const runtimeInputFields = [
  ["LXE_DESKTOP_NODE_ROOT", "node_root"],
  ["LXE_DESKTOP_PYTHON_ROOT", "python_root"],
  ["LXE_DESKTOP_UV_PATH", "uv_path"],
  ["LXE_DESKTOP_RG_PATH", "rg_path"],
  ["LXE_DESKTOP_PLAYWRIGHT_ROOT", "playwright_root"],
] as const;

type RuntimeInputKey = (typeof runtimeInputFields)[number][1];

export interface DesktopRuntimeInputs {
  nodeRoot: string;
  pythonRoot: string;
  uvExecutable: string;
  ripgrepExecutable: string;
  playwrightRoot: string;
}

interface DesktopRuntimeDescriptor {
  schema_version: number;
  platform: string;
  lock_sha256: string;
  inputs: Record<RuntimeInputKey, string>;
}

export interface ResolveDesktopRuntimeInputsOptions {
  repositoryRoot: string;
  environment?: Record<string, string | undefined>;
  expectedLockSha256?: string;
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const desktopRuntimeLockSha256 = (repositoryRoot: string): string => {
  const lines = lockInputPaths.map((relativePath) => {
    const absolutePath = join(repositoryRoot, ...relativePath.split("/"));
    if (!existsSync(absolutePath)) {
      throw new Error(`Desktop runtime lock input is missing: ${absolutePath}`);
    }
    return `${relativePath}=${sha256(readFileSync(absolutePath))}`;
  });
  return sha256(`${lines.join("\n")}\n`);
};

const parseDescriptor = (
  descriptorPath: string,
  expectedLockSha256: string,
): DesktopRuntimeDescriptor => {
  if (!existsSync(descriptorPath)) {
    throw new Error(
      `Desktop runtime descriptor is missing: ${descriptorPath}. `
      + "Run bun run desktop:runtime:win first.",
    );
  }
  let descriptor: DesktopRuntimeDescriptor;
  try {
    const source = readFileSync(descriptorPath, "utf8").replace(/^\uFEFF/u, "");
    descriptor = JSON.parse(source) as DesktopRuntimeDescriptor;
  } catch (error) {
    throw new Error(`Desktop runtime descriptor is invalid: ${descriptorPath}`, { cause: error });
  }
  if (descriptor.schema_version !== 1 || descriptor.platform !== "win32-x64") {
    throw new Error(`Desktop runtime descriptor is incompatible: ${descriptorPath}`);
  }
  if (descriptor.lock_sha256 !== expectedLockSha256) {
    throw new Error(
      `Desktop runtime descriptor has a stale lock fingerprint: ${descriptorPath}. `
      + "Rebuild the managed runtime.",
    );
  }
  if (!descriptor.inputs || typeof descriptor.inputs !== "object") {
    throw new Error(`Desktop runtime descriptor has no inputs object: ${descriptorPath}`);
  }
  return descriptor;
};

export const resolveDesktopRuntimeInputs = (
  options: ResolveDesktopRuntimeInputsOptions,
): DesktopRuntimeInputs => {
  const environment = options.environment ?? process.env;
  const needsDescriptor = runtimeInputFields.some(
    ([environmentName]) => !String(environment[environmentName] ?? "").trim(),
  );
  let descriptor: DesktopRuntimeDescriptor | undefined;
  if (needsDescriptor) {
    const configuredDescriptor = String(environment.LXE_DESKTOP_RUNTIME_DESCRIPTOR ?? "").trim();
    const descriptorPath = resolve(
      configuredDescriptor || join(options.repositoryRoot, "build", "desktop-runtime-inputs.json"),
    );
    descriptor = parseDescriptor(
      descriptorPath,
      options.expectedLockSha256 ?? desktopRuntimeLockSha256(options.repositoryRoot),
    );
  }

  const values = Object.fromEntries(runtimeInputFields.map(([environmentName, inputKey]) => {
    const configured = String(environment[environmentName] ?? "").trim();
    const value = configured || String(descriptor?.inputs[inputKey] ?? "").trim();
    if (!value) {
      throw new Error(`Desktop runtime input is empty: ${environmentName}`);
    }
    const path = resolve(value);
    if (!existsSync(path)) {
      throw new Error(`Desktop runtime input is missing: ${environmentName} (${path})`);
    }
    return [inputKey, path];
  })) as Record<RuntimeInputKey, string>;

  return {
    nodeRoot: values.node_root,
    pythonRoot: values.python_root,
    uvExecutable: values.uv_path,
    ripgrepExecutable: values.rg_path,
    playwrightRoot: values.playwright_root,
  };
};
