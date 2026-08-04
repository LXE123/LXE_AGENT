import { ModelImageProcessor } from "../../providers/model-image";
import { ExecShellAdapter } from "../exec-shell";
import type { ToolRegistry } from "../registry";
import { createExecTools } from "./exec-tools";
import { createFileTools } from "./file-tools";
import { FileVersionLedger } from "./file-version-ledger";
import { CodingPathPolicy } from "./path-policy";
import { CodingProcessManager } from "./process-manager";
import type { CodingToolOptions } from "./public-types";
import { createSearchTools } from "./search-tools";
import { createSendFilesTool } from "./send-files-tool";

export function registerCodingTools(
  registry: ToolRegistry,
  options: CodingToolOptions,
): CodingProcessManager {
  const toolOutputLimit = 10_000;
  // Anything past this is still captured: the process manager streams the full
  // transcript to var/tmp/exec and hands the model the tail plus that path.
  const processOutputLimit = Math.max(1_000, Math.trunc(options.maxOutputBytes ?? 50_000));
  const paths = new CodingPathPolicy({
    ...(options.repositorySkillsRoot === undefined ? {} : { repositorySkillsRoot: options.repositorySkillsRoot }),
    ...(options.userSkillsRoot === undefined ? {} : { userSkillsRoot: options.userSkillsRoot }),
    ...(options.artifactRoot === undefined ? {} : { artifactRoot: options.artifactRoot }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  });
  const ledger = new FileVersionLedger();
  const imageProcessor = new ModelImageProcessor();
  const execShell = options.execShell ?? new ExecShellAdapter();
  const processes = new CodingProcessManager({
    maxOutputBytes: processOutputLimit,
    tailBytes: 2_000,
    shell: execShell,
  });
  processes.onComplete = options.onExecComplete;

  for (const tool of createFileTools({
    paths,
    ledger,
    imageProcessor,
    toolOutputLimit,
    ...(options.attachmentPaths ? { attachmentPaths: options.attachmentPaths } : {}),
  })) {
    registry.register(tool);
  }
  for (const tool of createSearchTools({
    paths,
    toolOutputLimit,
    ...(options.ripgrepPath === undefined ? {} : { ripgrepPath: options.ripgrepPath }),
  })) {
    registry.register(tool);
  }
  registry.register(createSendFilesTool({ paths }));
  for (const tool of createExecTools({
    paths,
    processes,
    execShell,
    maxOutputBytes: processOutputLimit,
    options,
  })) {
    registry.register(tool);
  }
  return processes;
}
