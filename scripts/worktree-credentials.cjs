// Offline safeStorage bridge. Transfer files are encrypted using a one-use key.
const { app, safeStorage } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { resolve } = require("node:path");
const [mode, appName, profile, file, transfer] = process.argv.slice(2);
if (!["export", "import", "idle"].includes(mode) || !appName || !profile || !transfer) throw Error("Invalid credential bridge arguments");
const key = Buffer.from(process.env.LXE_WORKTREE_TRANSFER_KEY || "", "base64");
delete process.env.LXE_WORKTREE_TRANSFER_KEY;
if (key.length !== 32) throw Error("Missing one-use credential transfer key");
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setName(appName);
app.setPath("userData", resolve(profile));
app.setPath("sessionData", resolve(profile));
app.disableHardwareAcceleration();
if (mode !== "export" && !app.requestSingleInstanceLock()) {
  process.stderr.write("The worktree desktop is running; close it before preparing configuration.\n");
  app.exit(1);
} else {
  app.whenReady().then(() => {
    if (mode === "idle") { app.quit(); return; }
    if (!safeStorage.isEncryptionAvailable()) throw Error("OS credential encryption is unavailable");
    if (mode === "export") {
      const plaintext = safeStorage.decryptString(readFileSync(file));
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      writeFileSync(transfer, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    } else {
      const transferred = readFileSync(transfer);
      const decipher = createDecipheriv("aes-256-gcm", key, transferred.subarray(0, 12));
      decipher.setAuthTag(transferred.subarray(12, 28));
      const bytes = Buffer.concat([decipher.update(transferred.subarray(28)), decipher.final()]);
      const plaintext = bytes.toString("utf8");
      if (!plaintext) throw Error("Cannot import empty credentials");
      const encrypted = safeStorage.encryptString(plaintext);
      if (safeStorage.decryptString(encrypted) !== plaintext) throw Error("Credential round-trip verification failed");
      writeFileSync(file, encrypted, { mode: 0o600 });
      bytes.fill(0);
    }
    key.fill(0);
    app.quit();
  }).catch(error => { process.stderr.write(String(error.stack || error) + "\n"); app.exit(1); });
}
