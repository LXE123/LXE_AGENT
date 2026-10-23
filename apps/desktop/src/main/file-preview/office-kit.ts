import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Only the public Kit API used by desktop previews. Kit remains an external resource. */
export interface OfficeConverter {
  render(options: { inputPath: string; outputPath: string }, signal?: AbortSignal): Promise<{ missingFonts: string[] }>;
  dispose(): Promise<void>;
}

export async function createOfficeConverter(kitCliPath: string): Promise<OfficeConverter> {
  // Resolve the package beside the bundled CLI, through its public export.
  // Do not bundle Kit: its workers and native resources use paths relative to the package.
  const entry = createRequire(kitCliPath).resolve("@deepseek-ai/libreoffice-kit");
  const { createConverter } = await import(pathToFileURL(entry).href);
  return createConverter({
    timeoutMs: 60_000,
    maxInputBytes: 50 * 1024 * 1024,
    maxOutputBytes: 50 * 1024 * 1024,
  });
}
