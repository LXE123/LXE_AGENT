import { rmSync } from "node:fs";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

export const removeTemporaryRoot = async (root: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_REMOVE_CODES.has(code) || attempt >= 19) throw error;
      await Bun.sleep(50);
    }
  }
};
