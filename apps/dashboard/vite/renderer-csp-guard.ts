import type { Plugin } from "vite";

export function assertNoRuntimeSchemaCompiler(moduleIds: Iterable<string>): void {
  for (const id of moduleIds) {
    if (!id.replaceAll("\\", "/").includes("/node_modules/ajv/")) continue;
    throw new Error(
      `Production Renderer includes Ajv (${id}), whose runtime compilation violates script-src 'self'. `
      + "Import browser-safe protocol subpaths instead of the server validation entry point.",
    );
  }
}

export function rendererCspGuard(): Plugin {
  return {
    name: "lxe-renderer-csp-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") assertNoRuntimeSchemaCompiler(Object.keys(output.modules));
      }
    },
  };
}
