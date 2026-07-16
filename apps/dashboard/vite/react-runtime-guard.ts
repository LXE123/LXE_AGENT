import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { OutputChunk, Plugin } from "vite";

export const REACT_RUNTIME_PACKAGES = ["react", "react-dom"] as const;

type ReactRuntimePackage = typeof REACT_RUNTIME_PACKAGES[number];
type ReactRuntimeRoots = Record<ReactRuntimePackage, string[]>;

function modulePackageRoot(moduleId: string, packageName: ReactRuntimePackage): string | undefined {
  const normalizedId = moduleId.replace(/^\0+/, "").split("?", 1)[0].replaceAll("\\", "/");
  const packageSegment = `/node_modules/${packageName}/`;
  const packageIndex = normalizedId.lastIndexOf(packageSegment);
  if (packageIndex < 0) return undefined;

  const normalizedRoot = normalizedId.slice(0, packageIndex + packageSegment.length - 1);
  const packageJson = join(normalizedRoot, "package.json");
  if (!existsSync(packageJson)) return undefined;
  return realpathSync.native(normalizedRoot);
}

export function collectReactRuntimeRoots(moduleIds: Iterable<string>): ReactRuntimeRoots {
  const roots: Record<ReactRuntimePackage, Set<string>> = {
    react: new Set<string>(),
    "react-dom": new Set<string>(),
  };
  for (const moduleId of moduleIds) {
    for (const packageName of REACT_RUNTIME_PACKAGES) {
      const root = modulePackageRoot(moduleId, packageName);
      if (root) roots[packageName].add(root);
    }
  }
  return {
    react: [...roots.react].sort(),
    "react-dom": [...roots["react-dom"]].sort(),
  };
}

export function assertSingleReactRuntime(moduleIds: Iterable<string>): ReactRuntimeRoots {
  const roots = collectReactRuntimeRoots(moduleIds);
  for (const packageName of REACT_RUNTIME_PACKAGES) {
    if (roots[packageName].length === 1) continue;
    const detail = roots[packageName].length
      ? roots[packageName].join(", ")
      : "no runtime modules were emitted";
    throw new Error(
      `Production Renderer must contain exactly one ${packageName} runtime; found ${roots[packageName].length}: ${detail}`,
    );
  }
  return roots;
}

export function singleReactRuntimeGuard(): Plugin {
  return {
    name: "lxe-single-react-runtime-guard",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      const moduleIds = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const moduleId of Object.keys((output as OutputChunk).modules)) moduleIds.add(moduleId);
      }
      assertSingleReactRuntime(moduleIds);
    },
  };
}
