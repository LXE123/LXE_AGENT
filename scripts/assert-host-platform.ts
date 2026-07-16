const expectedPlatform = String(Bun.argv[2] ?? "").trim();
const expectedArchitecture = String(Bun.argv[3] ?? "").trim();

if (!expectedPlatform) {
  throw new Error("Usage: bun scripts/assert-host-platform.ts <platform> [architecture]");
}
if (process.platform !== expectedPlatform) {
  throw new Error(`This quality gate requires ${expectedPlatform}; current host is ${process.platform}`);
}
if (expectedArchitecture && process.arch !== expectedArchitecture) {
  throw new Error(
    `This quality gate requires ${expectedPlatform}-${expectedArchitecture}; current host is ${process.platform}-${process.arch}`,
  );
}

console.log(`Host platform verified: ${process.platform}-${process.arch}`);
