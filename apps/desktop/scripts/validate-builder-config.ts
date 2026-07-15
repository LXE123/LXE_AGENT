import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { CancellationToken, Packager } from "electron-builder";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const desktopBuilderConfigPath = join(desktopRoot, "electron-builder.yml");

export const validateDesktopBuilderConfig = async (
  configPath = desktopBuilderConfigPath,
): Promise<void> => {
  const packager = new Packager(
    {
      projectDir: desktopRoot,
      config: resolve(configPath),
    },
    new CancellationToken(),
  );
  await packager.validateConfig();
};

if (import.meta.main) {
  await validateDesktopBuilderConfig(process.argv[2]);
  console.log("electron-builder configuration is valid");
}
